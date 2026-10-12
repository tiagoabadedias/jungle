import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { assignLogContext, currentLogContext, runWithLogContext } from '../../src/shared/infrastructure/observability/log-context.ts';
import { createRootLogger, PinoNestLogger } from '../../src/shared/infrastructure/observability/logger.ts';
import { Metrics } from '../../src/shared/infrastructure/observability/metrics.ts';
import { recordWagerFailure, recordWagerResult } from '../../src/wagering/infrastructure/observability/wager-telemetry.ts';
import { IdempotencyConflictError } from '../../src/shared/application/application-error.ts';
import { errorMessage } from '../../src/shared/application/error-message.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, logger: createRootLogger('info', stream) };
}

describe('logs estruturados (§12)', () => {
  test('JSON com os ids do contexto (correlationId, messageId, transactionId, walletId, providerId)', () => {
    const { lines, logger } = capture();
    runWithLogContext({ correlationId: 'corr-1', messageId: 'msg-1' }, () => {
      assignLogContext({ walletId: 'w-1', providerId: 'provider-a' });
      assignLogContext({ transactionId: 'tx-1' });
      logger.info({ status: 'PROCESSED' }, 'wager transaction handled');
    });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'wagering-processor',
      msg: 'wager transaction handled',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
  });

  test('payloads e valores monetários são censurados mesmo se alguém tentar logá-los', () => {
    const { lines, logger } = capture();
    logger.info({ money: { amount: '25.00' }, request: { body: { amount: '1.00' }, balance: { amount: '9.00' } } }, 'oops');
    expect(lines[0]?.['money']).toBe('[redacted]');
    expect(lines[0]?.['request']).toEqual({ body: '[redacted]', balance: '[redacted]' });
    expect(JSON.stringify(lines[0])).not.toContain('25.00');
  });

  test('contextos de requisições concorrentes não se misturam', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithLogContext({ correlationId: id }, async () => {
          await Bun.sleep(5);
          seen.push(`${id}:${currentLogContext().correlationId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
  });

  test('adaptador do NestJS: objeto vira campos, contexto e stack preservados', () => {
    const { lines, logger } = capture();
    const nest = new PinoNestLogger(logger);
    nest.log({ msg: 'listening', port: 3000 }, 'Lifecycle');
    nest.error('boom', 'stack-trace', 'HttpErrorFilter');
    nest.warn('plain text');
    expect(lines[0]).toMatchObject({ msg: 'listening', port: 3000, context: 'Lifecycle', level: 'info' });
    expect(lines[1]).toMatchObject({ msg: 'boom', stack: 'stack-trace', context: 'HttpErrorFilter', level: 'error' });
    expect(lines[2]).toMatchObject({ msg: 'plain text', level: 'warn' });
  });

  test('detail do PostgreSQL (linha inteira que falhou) nunca chega ao log', () => {
    const { lines, logger } = capture();
    const nest = new PinoNestLogger(logger);
    const message = 'new row for relation "wallets" violates check constraint "wallets_balance_non_negative_ck"';
    const failure = new Error(`${message}\n - detail: Failing row contains (w-1, p-1, BRL, -1, 2).\n - hint: some hint`);
    nest.error(failure);
    nest.error({ msg: 'tick failed', error: errorMessage(failure) });
    nest.error({ msg: 'unhandled', error: failure.message }, failure.stack, 'HttpErrorFilter');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(JSON.stringify(line)).not.toContain('Failing row');
    expect(lines[0]).toMatchObject({ msg: message, err: { message } });
    expect(lines[1]).toMatchObject({ error: message });
    expect(lines[2]?.['stack']).toContain(message);
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('métricas (§12)', () => {
  test('transações por status, duplicatas e latência; labels sem ids', async () => {
    const metrics = new Metrics();
    const view = { transactionId: 'tx', status: WagerTransactionStatus.Processed, balance: undefined, idempotentReplay: true };
    recordWagerResult(metrics, 'http', 'BET', view, 0.012);
    recordWagerResult(metrics, 'sqs', 'NOT_A_KIND', { ...view, idempotentReplay: false }, 0.02);
    recordWagerFailure(metrics, 'http', new IdempotencyConflictError('x', 'tx'), 0.003);
    const text = await metrics.registry.metrics();
    expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="BET",source="http"} 1');
    expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="INVALID",source="sqs"} 1');
    expect(text).toContain('wagering_duplicates_detected_total{kind="idempotent_replay",source="http"} 1');
    expect(text).toContain('wagering_duplicates_detected_total{kind="idempotency_conflict",source="http"} 1');
    expect(text).toContain('wagering_processing_duration_seconds_count{source="http",outcome="PROCESSED"} 1');
    expect(text).not.toContain('tx"');
  });

  test('outbox lag consultado a cada scrape', async () => {
    const metrics = new Metrics();
    metrics.useOutboxBacklogProbe({ backlog: async () => ({ pending: 7, oldestAgeSeconds: 12.5 }) });
    const text = await metrics.registry.metrics();
    expect(text).toContain('wagering_outbox_lag_seconds 12.5');
    expect(text).toContain('wagering_outbox_pending 7');
  });

  test('lag e pendentes saem da mesma consulta, no mesmo scrape, mesmo com I/O lento (registry serializa em paralelo)', async () => {
    const metrics = new Metrics();
    let queries = 0;
    let pending = 3;
    metrics.useOutboxBacklogProbe({
      backlog: async () => {
        queries += 1;
        await Bun.sleep(20); // I/O real: resolve depois que o registry já começou a ler os outros gauges
        return { pending, oldestAgeSeconds: 4 };
      },
    });
    expect(await metrics.registry.metrics()).toContain('wagering_outbox_pending 3');
    pending = 9;
    expect(await metrics.registry.metrics()).toContain('wagering_outbox_pending 9'); // nunca o valor do scrape anterior
    expect(queries).toBe(2); // uma consulta por scrape, compartilhada pelos dois gauges
  });
});
