import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WagerTransactionStatus } from '../../../src/wagering/domain/wager-transaction-status.ts';
import type { TransactionScope, UnitOfWork } from '../../../src/shared/application/ports/unit-of-work.ts';
import { ReprocessPendingReferencesUseCase } from '../../../src/wagering/application/reprocess-pending-references.use-case.ts';
import { execute } from '../../helpers/database.ts';
import { MessagingHarness, MutableClock } from '../../helpers/messaging.ts';

/** Referências fora de ordem (§7.1, §13 conc. 7) com o worker agendado e PostgreSQL real. */
const clock = new MutableClock(new Date());
let h: MessagingHarness;

beforeAll(async () => {
  h = await MessagingHarness.start({ clock });
});

// Invariante final (§13): wallet.balance == saldo reconstruído pelo ledger.
afterEach(async () => {
  await h.assertLedgerInvariant();
});

afterAll(async () => {
  await h.stop();
});

async function submit(wallet: { walletId: string; playerId: string }, kind: string, amount: string, overrides = {}) {
  const data = h.wagerData(wallet, kind, amount, overrides);
  const result = await h.processUseCase().execute({ ...data, context: { correlationId: `c-${randomUUID()}` } });
  return { data, result };
}

async function transaction(id: string) {
  const [row] = await execute<{ status: string; failure_code: string | null; reference_attempts: number }>(
    h.orm,
    'select status, failure_code, reference_attempts from wager_transactions where id = ?',
    [id],
  );
  return row;
}

async function balance(walletId: string): Promise<string> {
  const [row] = await execute<{ b: string }>(h.orm, 'select balance_minor::text as b from wallets where id = ?', [walletId]);
  return row?.b ?? 'missing';
}

async function outboxTypes(walletId: string): Promise<string[]> {
  const rows = await execute<{ event_type: string }>(
    h.orm,
    'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type',
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

describe('ROLLBACK/REFUND entregue antes da referência', () => {
  test('fica PENDING_REFERENCE com evento; a BET chega; o worker aplica a reversão', async () => {
    const wallet = await h.createWallet('100.00');
    const betId = `bet-${randomUUID()}`;
    const rollback = await submit(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: betId });
    expect(rollback.result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await outboxTypes(wallet.walletId)).toContain('WagerTransactionPendingReference');

    await submit(wallet, 'BET', '30.00', { externalTransactionId: betId, idempotencyKey: `provider-a:${betId}` });
    expect(await balance(wallet.walletId)).toBe('7000');

    // Ainda não venceu o backoff (2 s): o worker não mexe.
    await h.reprocessUseCase().runOnce();
    expect((await transaction(rollback.result.transactionId))?.status).toBe('PENDING_REFERENCE');

    clock.advance(2_500);
    const summary = await h.reprocessUseCase().runOnce();
    expect(summary.outcomes.PROCESSED).toBeGreaterThanOrEqual(1);
    expect(summary.items).toContainEqual(
      expect.objectContaining({ transactionId: rollback.result.transactionId, kind: 'ROLLBACK', outcome: 'PROCESSED' }),
    );
    expect(await transaction(rollback.result.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await balance(wallet.walletId)).toBe('10000');
    const events = await outboxTypes(wallet.walletId);
    expect(events.filter((e) => e === 'WalletBalanceChanged')).toHaveLength(3); // OPENING, BET, ROLLBACK
  });

  test('referência que nunca chega: reagenda com backoff e, esgotado o limite, REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const wallet = await h.createWallet('100.00');
    const refund = await submit(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: `never-${randomUUID()}` });

    clock.advance(2_500);
    await h.reprocessUseCase().runOnce(); // tentativa 1 → reagendada (+4 s)
    expect(await transaction(refund.result.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });

    clock.advance(4_500);
    await h.reprocessUseCase().runOnce(); // tentativa 2 → reagendada (+8 s)
    clock.advance(8_500);
    await h.reprocessUseCase().runOnce(); // tentativa 3 = maxAttempts → rejeitada

    expect(await transaction(refund.result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 3,
    });
    expect(await outboxTypes(wallet.walletId)).toContain('WagerTransactionRejected');
    expect(await balance(wallet.walletId)).toBe('10000');
  });

  test('dois workers ao mesmo tempo sobre a mesma pendência: aplicada uma única vez', async () => {
    const wallet = await h.createWallet('100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = await submit(wallet, 'REFUND', '25.00', { referenceExternalTransactionId: betId });
    await submit(wallet, 'BET', '25.00', { externalTransactionId: betId, idempotencyKey: `provider-a:${betId}` });

    clock.advance(2_500);
    await Promise.all([h.reprocessUseCase().runOnce(), h.reprocessUseCase().runOnce()]);

    expect(await transaction(refund.result.transactionId)).toMatchObject({ status: 'PROCESSED' });
    const credits = await execute(
      h.orm,
      `select 1 from wallet_ledger_entries where transaction_id = ?`,
      [refund.result.transactionId],
    );
    expect(credits).toHaveLength(1);
    expect(await balance(wallet.walletId)).toBe('10000');
  });

  test('erro permanente num item: ele vira FAILED (auditável) e os demais continuam sendo processados', async () => {
    const wallet = await h.createWallet('100.00');
    const poisonBet = `bet-${randomUUID()}`;
    const healthyBet = `bet-${randomUUID()}`;
    const poisoned = await submit(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: poisonBet });
    const healthy = await submit(wallet, 'REFUND', '20.00', { referenceExternalTransactionId: healthyBet });
    await submit(wallet, 'BET', '10.00', { externalTransactionId: poisonBet, idempotencyKey: `provider-a:${poisonBet}` });
    await submit(wallet, 'BET', '20.00', { externalTransactionId: healthyBet, idempotencyKey: `provider-a:${healthyBet}` });

    // UnitOfWork real cujo ledger falha (bug simulado) só para a transação envenenada.
    const inner = h.unitOfWork();
    const poisonedUow: UnitOfWork = {
      run: (work) =>
        inner.run((scope: TransactionScope) =>
          work({
            ...scope,
            ledger: {
              insert: async (entry) => {
                if (entry.transactionId === poisoned.result.transactionId) throw new Error('simulated persistent bug');
                return scope.ledger.insert(entry);
              },
              page: (walletId, after, limit) => scope.ledger.page(walletId, after, limit),
              totals: (walletId) => scope.ledger.totals(walletId),
            },
          }),
        ),
    };
    const worker = new ReprocessPendingReferencesUseCase(poisonedUow, clock, h.ids, h.referenceRetry, 100);

    clock.advance(2_500);
    const summary = await worker.runOnce(); // não lança

    expect(summary.items).toContainEqual(
      expect.objectContaining({ transactionId: poisoned.result.transactionId, outcome: 'FAILED', failureCode: 'INFRA_PERMANENT_FAILURE' }),
    );
    expect(await transaction(poisoned.result.transactionId)).toMatchObject({ status: 'FAILED', failure_code: 'INFRA_PERMANENT_FAILURE' });
    expect(await transaction(healthy.result.transactionId)).toMatchObject({ status: 'PROCESSED' });
    // REFUND de 20.00 aplicado; o de 10.00 falhou sem efeito: 100 − 10 − 20 + 20 = 90.00
    expect(await balance(wallet.walletId)).toBe('9000');

    // Terminal: um novo ciclo não toca mais nele.
    clock.advance(10_000);
    const next = await worker.runOnce();
    expect(next.items.find((item) => item.transactionId === poisoned.result.transactionId)).toBeUndefined();
  });
});
