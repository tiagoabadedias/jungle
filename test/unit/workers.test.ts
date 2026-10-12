import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { PublishOutboxUseCase } from '../../src/messaging/application/publish-outbox.use-case.ts';
import { createOutboxPublisherWorker } from '../../src/messaging/infrastructure/workers/outbox-publisher-worker.ts';
import { InvalidRequestError } from '../../src/shared/application/application-error.ts';
import { moneyFromInput } from '../../src/shared/application/money-input.ts';
import { Metrics } from '../../src/shared/infrastructure/observability/metrics.ts';
import type {
  ReprocessPendingReferencesUseCase,
  ReprocessSummary,
} from '../../src/wagering/application/reprocess-pending-references.use-case.ts';
import { createPendingReferenceWorker } from '../../src/wagering/infrastructure/workers/pending-reference-worker.ts';

// Os workers logam pelo Logger do Nest; aqui só interessam métricas e progresso.
beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));

/** Roda o worker até ele consumir os lotes roteirizados e dormir (intervalo longo), e para. */
async function runUntilIdle(worker: { start(): void; stop(): Promise<void> }, pending: () => number): Promise<void> {
  worker.start();
  const deadline = Date.now() + 2_000;
  while (pending() > 0 && Date.now() < deadline) await Bun.sleep(5);
  await worker.stop();
}

function summary(partial: Partial<ReprocessSummary['outcomes']>, items: ReprocessSummary['items'] = []): ReprocessSummary {
  return {
    outcomes: { PROCESSED: 0, REJECTED: 0, FAILED: 0, RESCHEDULED: 0, DEFERRED: 0, SKIPPED: 0, ...partial },
    items,
  };
}

const item = { walletId: 'w', providerId: 'provider-a', idempotencyKey: 'k', kind: 'ROLLBACK' };

describe('worker de referências pendentes', () => {
  test('contabiliza desfechos, retries e transações por status; reagendados não contam como progresso', async () => {
    const metrics = new Metrics();
    const batches: ReprocessSummary[] = [
      summary({ PROCESSED: 1, FAILED: 1, RESCHEDULED: 2, DEFERRED: 1 }, [
        { ...item, transactionId: 't1', outcome: 'PROCESSED' },
        { ...item, transactionId: 't2', outcome: 'FAILED', failureCode: 'INFRA_PERMANENT_FAILURE', error: 'boom' },
        { ...item, transactionId: 't3', outcome: 'RESCHEDULED' },
        { ...item, transactionId: 't4', outcome: 'RESCHEDULED' },
      ]),
    ];
    const ticks: number[] = [];
    const useCase = { runOnce: async () => batches.shift() ?? summary({}) } as unknown as ReprocessPendingReferencesUseCase;
    const worker = createPendingReferenceWorker(useCase, 60_000, metrics);
    const tick = Reflect.get(worker, 'tick') as () => Promise<number>;
    Reflect.set(worker, 'tick', async () => {
      const progress = await tick();
      ticks.push(progress);
      return progress;
    });

    await runUntilIdle(worker, () => batches.length);

    expect(ticks[0]).toBe(2); // PROCESSED + FAILED; RESCHEDULED e DEFERRED não giram o loop
    const text = await metrics.registry.metrics();
    expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="ROLLBACK",source="worker"} 1');
    expect(text).toContain('wagering_transactions_total{status="FAILED",kind="ROLLBACK",source="worker"} 1');
    expect(text).not.toContain('status="RESCHEDULED"');
    expect(text).toContain('wagering_pending_reference_outcomes_total{outcome="RESCHEDULED"} 2');
    expect(text).toContain('wagering_retries_total{component="pending_reference",reason="REFERENCE_MISSING"} 2');
    expect(text).toContain('wagering_retries_total{component="pending_reference",reason="TRANSIENT_FAILURE"} 1');
  });
});

describe('publisher da outbox', () => {
  test('conta publicados e reagendados; só a parte publicada é progresso', async () => {
    const metrics = new Metrics();
    const batches = [{ claimed: 5, published: 3, failed: 2 }];
    const ticks: number[] = [];
    const useCase = {
      publishBatch: async () => batches.shift() ?? { claimed: 0, published: 0, failed: 0 },
    } as unknown as PublishOutboxUseCase;
    const worker = createOutboxPublisherWorker(useCase, 60_000, metrics);
    const tick = Reflect.get(worker, 'tick') as () => Promise<number>;
    Reflect.set(worker, 'tick', async () => {
      const progress = await tick();
      ticks.push(progress);
      return progress;
    });

    await runUntilIdle(worker, () => batches.length);

    expect(ticks[0]).toBe(3);
    const text = await metrics.registry.metrics();
    expect(text).toContain('wagering_outbox_published_total 3');
    expect(text).toContain('wagering_retries_total{component="outbox_publisher",reason="PUBLISH_FAILED"} 2');
  });
});

describe('moneyFromInput', () => {
  test('formato inválido vindo de fora é erro de requisição (400 / DLQ), não de domínio', () => {
    expect(moneyFromInput({ amount: '25.00', currency: 'BRL' }).toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(() => moneyFromInput({ amount: '25.005', currency: 'BRL' })).toThrow(InvalidRequestError);
  });
});
