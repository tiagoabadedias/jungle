import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';
import type { EventPublisher } from '../../../src/messaging/application/ports/event-publisher.ts';
import { PublishOutboxUseCase } from '../../../src/messaging/application/publish-outbox.use-case.ts';
import { SqsEventPublisher } from '../../../src/messaging/infrastructure/sqs/sqs-event-publisher.ts';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff.ts';
import { execute } from '../../helpers/database.ts';
import { drainVisible, MessagingHarness } from '../../helpers/messaging.ts';

/** Transactional outbox (§11): publicação após o commit, publishers concorrentes, falhas. */
let h: MessagingHarness;

beforeAll(async () => {
  h = await MessagingHarness.start();
  // O banco de testes é compartilhado: drena eventos pendentes deixados por outros arquivos.
  const publisher = h.publishUseCase(h.queues.events, 200);
  while ((await publisher.publishBatch()).claimed > 0) {
    // continua até esvaziar
  }
  await drainVisible(h.sqs, h.queues.events, 30);
});

// Invariante final (§13): wallet.balance == saldo reconstruído pelo ledger.
afterEach(async () => {
  await h.assertLedgerInvariant();
});

afterAll(async () => {
  await h.stop();
});

async function placeBet(wallet: { walletId: string; playerId: string }, amount: string) {
  const data = h.wagerData(wallet, 'BET', amount);
  return h.processUseCase().execute({ ...data, context: { correlationId: `corr-${randomUUID()}` } });
}

async function pendingEventIds(walletId: string): Promise<string[]> {
  const rows = await execute<{ id: string }>(
    h.orm,
    'select id from outbox_messages where aggregate_id = ? and published_at is null order by occurred_at, id',
    [walletId],
  );
  return rows.map((row) => row.id);
}

describe('publicação depois do commit', () => {
  test('eventos da transação são gravados pendentes e publicados pelo worker com envelope, grupo e dedup', async () => {
    const wallet = await h.createWallet('100.00');
    await placeBet(wallet, '10.00');
    const pending = await pendingEventIds(wallet.walletId);
    expect(pending).toHaveLength(4); // OPENING: Processed + BalanceChanged; BET: Processed + BalanceChanged

    const result = await h.publishUseCase().publishBatch();
    expect(result.published).toBeGreaterThanOrEqual(4);
    expect(await pendingEventIds(wallet.walletId)).toHaveLength(0);

    const received = (await drainVisible(h.sqs, h.queues.events)).filter((m) => m.Attributes?.['MessageGroupId'] === wallet.walletId);
    expect(received.map((m) => m.Attributes?.['MessageDeduplicationId']).sort()).toEqual([...pending].sort());
    const balanceChanged = received
      .map((m) => JSON.parse(m.Body ?? '{}') as { eventType: string; data: Record<string, unknown> })
      .filter((e) => e.eventType === 'WalletBalanceChanged')
      .map((e) => e.data);
    expect(balanceChanged).toContainEqual(
      expect.objectContaining({
        walletId: wallet.walletId,
        direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      }),
    );
    for (const message of received) {
      expect(message.MessageAttributes?.['eventType']?.StringValue).toBeDefined();
    }
  });
});

describe('publishers concorrentes sobre a mesma outbox (§13 conc. 6)', () => {
  test('dois publishers em paralelo: cada evento é reivindicado por um só e todos são publicados', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => h.createWallet('100.00')));
    for (const wallet of wallets) for (let i = 0; i < 4; i += 1) await placeBet(wallet, '1.00');
    const expected = (await Promise.all(wallets.map((w) => pendingEventIds(w.walletId)))).flat();
    expect(expected).toHaveLength(5 * (2 + 4 * 2));

    // Cada publisher registra os ids que reivindicou e publicou.
    const seen: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const run = async (name: 'a' | 'b') => {
      const real = new SqsEventPublisher(h.sqs, h.queues.events);
      const recording: EventPublisher = {
        publish: async (messages: readonly OutboxMessage[]) => {
          seen[name].push(...messages.map((m) => m.id));
          return real.publish(messages);
        },
      };
      const publisher = new PublishOutboxUseCase(h.unitOfWork(), recording, h.clock, {
        batchSize: 7,
        backoff: ExponentialBackoff.create({ baseDelayMs: 1_000, maxDelayMs: 60_000 }),
      });
      while ((await publisher.publishBatch()).claimed > 0) {
        // drena até não haver mais pendências vencidas
      }
    };
    await Promise.all([run('a'), run('b')]);

    const a = new Set(seen.a);
    const overlap = seen.b.filter((id) => a.has(id));
    expect(overlap).toEqual([]); // SKIP LOCKED: nenhuma linha foi reivindicada pelos dois
    expect(seen.a.length).toBeGreaterThan(0);
    expect(seen.b.length).toBeGreaterThan(0);
    const union = new Set([...seen.a, ...seen.b]);
    for (const id of expected) expect(union.has(id)).toBe(true);
    for (const wallet of wallets) expect(await pendingEventIds(wallet.walletId)).toHaveLength(0);

    const groups = new Set(wallets.map((w) => w.walletId));
    const received = (await drainVisible(h.sqs, h.queues.events, 20)).filter((m) => groups.has(m.Attributes?.['MessageGroupId'] ?? ''));
    const receivedIds = new Set(received.map((m) => m.Attributes?.['MessageDeduplicationId']));
    for (const id of expected) expect(receivedIds.has(id)).toBe(true);
  });
});

describe('falhas na publicação', () => {
  test('broker indisponível: eventos continuam pendentes e são reagendados com backoff', async () => {
    const wallet = await h.createWallet('100.00');
    const pending = await pendingEventIds(wallet.walletId);
    const broken = h.publishUseCase('http://localhost:4566/000000000000/does-not-exist.fifo', 500);

    const result = await broken.publishBatch();

    expect(result.published).toBe(0);
    const rows = await execute<{ attempts: number; deferred: boolean }>(
      h.orm,
      `select attempts, next_attempt_at > now() as deferred from outbox_messages where id = any(?)`,
      [`{${pending.join(',')}}`],
    );
    expect(rows).toHaveLength(pending.length);
    for (const row of rows) expect(row).toEqual({ attempts: 1, deferred: true });
  });

  test('processo morre depois de publicar e antes do commit: outra instância republica (at-least-once)', async () => {
    const wallet = await h.createWallet('100.00');
    const pending = await pendingEventIds(wallet.walletId);

    // Publica de verdade e "morre" antes de marcar: a transação da outbox sofre rollback.
    const real = new SqsEventPublisher(h.sqs, h.queues.events);
    const crashing: EventPublisher = {
      publish: async (messages: readonly OutboxMessage[]) => {
        await real.publish(messages);
        throw new Error('process crashed after publishing');
      },
    };
    const crashingUseCase = new PublishOutboxUseCase(h.unitOfWork(), crashing, h.clock, {
      batchSize: 500,
      backoff: ExponentialBackoff.create({ baseDelayMs: 1, maxDelayMs: 1 }),
    });
    await crashingUseCase.publishBatch().catch(() => undefined);
    // Com o crash simulado pelo erro do publisher, as mensagens foram reagendadas (attempts=1);
    // o importante é que nenhuma foi marcada como publicada.
    expect(await pendingEventIds(wallet.walletId)).toEqual(pending);

    await Bun.sleep(20);
    const recovery = await h.publishUseCase(h.queues.events, 500).publishBatch();
    expect(recovery.published).toBeGreaterThanOrEqual(pending.length);
    expect(await pendingEventIds(wallet.walletId)).toHaveLength(0);
  });
});
