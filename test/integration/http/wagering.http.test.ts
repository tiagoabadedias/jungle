import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execute } from '../../helpers/database.ts';
import { TestApp, wager } from '../../helpers/app.ts';

let api: TestApp;

beforeAll(async () => {
  api = await TestApp.start();
});

afterAll(async () => {
  await api.stop();
});

async function outboxEvents(walletId: string): Promise<string[]> {
  const rows = await execute<{ event_type: string }>(
    api.db,
    `select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type`,
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

describe('POST /wagering/transactions — resultados e status HTTP (§9)', () => {
  test('BET processada → 201 com saldo após o débito', async () => {
    const wallet = await api.createWallet('1000.00');
    const response = await api.submit(wager(wallet, 'BET', '25.00'));
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('saldo insuficiente → 422 com failureCode e retryable, sem ledger', async () => {
    const wallet = await api.createWallet('10.00');
    const response = await api.submit(wager(wallet, 'BET', '10.01'));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('referência ausente → 202 PENDING_REFERENCE', async () => {
    const wallet = await api.createWallet('100.00');
    const response = await api.submit(wager(wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: `bet-${randomUUID()}` }));
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00', currency: 'BRL' } });
    const details = await api.request('GET', `/wagering/transactions/${response.body.transactionId}`);
    expect(details.body).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 0, nextReferenceAttemptAt: expect.any(String) });
  });

  test.each([
    ['sem Idempotency-Key', undefined, {}],
    ['kind OPENING', 'k', { kind: 'OPENING' }],
    ['amount number', 'k', { money: { amount: 25, currency: 'BRL' } }],
    ['amount 25.005', 'k', { money: { amount: '25.005', currency: 'BRL' } }],
    ['BET com valor zero', 'k', { money: { amount: '0.00', currency: 'BRL' } }],
    ['BET com referência', 'k', { referenceExternalTransactionId: 'x' }],
    ['referência vazia', 'k', { referenceExternalTransactionId: '' }],
    ['referência em branco', 'k', { referenceExternalTransactionId: '   ' }],
    ['walletId malformado', 'k', { walletId: 'nope' }],
    ['providerId reservado "internal"', 'k', { providerId: 'internal' }],
  ])('payload inválido (%s) → 400', async (_, key, overrides) => {
    const wallet = await api.createWallet('100.00');
    const payload = { ...wager(wallet, 'BET', '25.00'), ...overrides };
    const response = await api.submit(payload as ReturnType<typeof wager>, key === undefined ? null : `k-${randomUUID()}`);
    expect(response.status).toBe(400);
  });

  test('REFUND sem referência → 400', async () => {
    const wallet = await api.createWallet('100.00');
    expect((await api.submit(wager(wallet, 'REFUND', '1.00'))).status).toBe(400);
  });

  test('wallet inexistente → 404', async () => {
    const response = await api.submit(wager({ walletId: randomUUID(), playerId: randomUUID() }, 'BET', '1.00'));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('moeda diferente da wallet → 422 CURRENCY_MISMATCH', async () => {
    const wallet = await api.createWallet('100.00');
    const response = await api.submit(wager(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('player diferente do dono da wallet → 422 WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await api.createWallet('100.00');
    const response = await api.submit(wager(wallet, 'BET', '1.00', { playerId: randomUUID() }));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });
});

describe('idempotência persistente (§9)', () => {
  test('requisição idêntica → mesma resposta, mesmo status, idempotentReplay: true, sem novo efeito', async () => {
    const wallet = await api.createWallet('100.00');
    const payload = wager(wallet, 'BET', '40.00');
    const first = await api.submit(payload);
    await api.submit(wager(wallet, 'BET', '10.00')); // saldo muda depois
    const replay = await api.submit(payload);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: '60.00', currency: 'BRL' }); // saldo observado na época (§7.7)
    const debits = await execute(api.db, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.walletId]);
    expect(debits).toHaveLength(2);
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('replay de uma rejeição devolve a rejeição original (422)', async () => {
    const wallet = await api.createWallet('1.00');
    const payload = wager(wallet, 'BET', '5.00');
    const first = await api.submit(payload);
    const replay = await api.submit(payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma key com payload diferente → 409 conflito, não replay', async () => {
    const wallet = await api.createWallet('100.00');
    const payload = wager(wallet, 'BET', '10.00');
    await api.submit(payload);
    const conflict = await api.submit({ ...payload, money: { amount: '11.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('mesmo id externo com outra key → 409', async () => {
    const wallet = await api.createWallet('100.00');
    const payload = wager(wallet, 'BET', '10.00');
    await api.submit(payload);
    const response = await api.submit(payload, `another-key-${randomUUID()}`);
    expect(response.status).toBe(409);
  });

  test('mesma key apontando para outra wallet → 409 (o hash inclui walletId)', async () => {
    const walletA = await api.createWallet('100.00');
    const walletB = await api.createWallet('100.00');
    const payload = wager(walletA, 'BET', '10.00');
    await api.submit(payload);
    const response = await api.submit({ ...payload, walletId: walletB.walletId, playerId: walletB.playerId });
    expect(response.status).toBe(409);
    await api.assertLedgerConsistency(walletB.walletId);
  });
});

describe('fluxos por operação via HTTP (§7)', () => {
  test('BET → WIN (com referência) → LOSS: saldo, ledger e eventos', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wager(wallet, 'BET', '20.00');
    expect((await api.submit(bet)).status).toBe(201);
    const win = await api.submit(wager(wallet, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.status).toBe(201);
    expect(win.body.balance).toEqual({ amount: '130.00', currency: 'BRL' });
    const loss = await api.submit(wager(wallet, 'LOSS', '0.00'));
    expect(loss.status).toBe(201);
    expect(loss.body.balance).toEqual({ amount: '130.00', currency: 'BRL' });

    const events = await outboxEvents(wallet.walletId);
    // OPENING (2) + BET (2) + WIN (2) + LOSS (1: sem WalletBalanceChanged)
    expect(events.filter((e) => e === 'WagerTransactionProcessed')).toHaveLength(4);
    expect(events.filter((e) => e === 'WalletBalanceChanged')).toHaveLength(3);
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('REFUND reverte a BET uma única vez; segunda reversão → 422 REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    await api.submit(bet);
    const refund = await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(201);
    expect(refund.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const rollback = await api.submit(wager(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('a transação referenciada não é regravada (o trigger de terminais não dispara)', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    const betResponse = await api.submit(bet);
    const before = await execute<{ updated_at: Date }>(api.db, 'select updated_at from wager_transactions where id = ?', [
      betResponse.body.transactionId,
    ]);
    await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    const after = await execute<{ updated_at: Date }>(api.db, 'select updated_at from wager_transactions where id = ?', [
      betResponse.body.transactionId,
    ]);
    expect(after).toEqual(before);
  });

  test('ROLLBACK de WIN sem saldo → 422 REVERSAL_INSUFFICIENT_FUNDS, auditável', async () => {
    const wallet = await api.createWallet('0.00');
    const win = wager(wallet, 'WIN', '50.00');
    await api.submit(win);
    await api.submit(wager(wallet, 'BET', '45.00'));
    const rollback = await api.submit(wager(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const stored = await api.request('GET', `/wagering/transactions/${rollback.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    await api.assertLedgerConsistency(wallet.walletId);
  });
});

describe('consultas', () => {
  test('GET por id interno e por (provider, id externo)', async () => {
    const wallet = await api.createWallet('100.00');
    const payload = wager(wallet, 'BET', '5.00');
    const created = await api.submit(payload);
    const byId = await api.request('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: payload.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '5.00', currency: 'BRL' },
      balance: { amount: '95.00', currency: 'BRL' },
    });
    const byExternal = await api.request('GET', `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);
  });

  test('inexistente → 404', async () => {
    expect((await api.request('GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await api.request('GET', `/providers/provider-a/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });
});
