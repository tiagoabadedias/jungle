import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execute } from '../helpers/database.ts';
import { TestApp, wager } from '../helpers/app.ts';

/**
 * Paralelismo real (§13 "não mocks sequenciais"): requisições HTTP simultâneas contra o
 * servidor NestJS, cada uma numa transação PostgreSQL própria do pool. Os cenários com
 * múltiplos processos (≥ 3 instâncias) ficam em `multi-instance.test.ts`.
 */
let api: TestApp;

beforeAll(async () => {
  api = await TestApp.start();
});

afterAll(async () => {
  await api.stop();
});

async function debitCount(walletId: string): Promise<number> {
  const rows = await execute(api.db, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
  return rows.length;
}

describe('§13 concorrência', () => {
  test('1. a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const wallet = await api.createWallet('1000.00');
    const payload = wager(wallet, 'BET', '25.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => api.submit(payload)));

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(responses.filter((r) => r.body.idempotentReplay)).toHaveLength(49);
    for (const response of responses) expect(response.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(await debitCount(wallet.walletId)).toBe(1);
    expect((await api.request('GET', `/wallets/${wallet.walletId}`)).body['balance']).toEqual({ amount: '975.00', currency: 'BRL' });
    await api.assertLedgerConsistency(wallet.walletId);
  });

  test('2. cenário obrigatório do §8: 100.00 e duas apostas de 80.00 simultâneas (repetido 10×)', async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await api.createWallet('100.00');
      const payloads = [wager(wallet, 'BET', '80.00'), wager(wallet, 'BET', '80.00')];
      const results = await Promise.all(payloads.map((payload) => api.submit(payload)));

      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(1);
      const rejected = results.find((r) => r.body.status === 'REJECTED');
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect((await api.request('GET', `/wallets/${wallet.walletId}`)).body['balance']).toEqual({ amount: '20.00', currency: 'BRL' });
      expect(await debitCount(wallet.walletId)).toBe(1);

      // Nenhum retry duplica o débito: reenvios simultâneos devolvem o resultado original.
      const retries = await Promise.all(payloads.map((payload) => api.submit(payload)));
      expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
      expect(retries.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await debitCount(wallet.walletId)).toBe(1);
      await api.assertLedgerConsistency(wallet.walletId);
    }
  });

  test('3. wallets distintas processadas em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => api.createWallet('100.00')));
    const responses = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 10 }, () => api.submit(wager(wallet, 'BET', '7.00')))),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect((await api.request('GET', `/wallets/${wallet.walletId}`)).body['balance']).toEqual({ amount: '30.00', currency: 'BRL' });
      await api.assertLedgerConsistency(wallet.walletId);
    }
  });

  test('mesma key em wallets diferentes simultaneamente: o UNIQUE do banco decide, a perdedora recebe 409', async () => {
    for (let round = 0; round < 10; round += 1) {
      const walletA = await api.createWallet('100.00');
      const walletB = await api.createWallet('100.00');
      const payloadA = wager(walletA, 'BET', '10.00');
      const payloadB = { ...payloadA, walletId: walletB.walletId, playerId: walletB.playerId };

      const [a, b] = await Promise.all([api.submit(payloadA), api.submit(payloadB)]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const winner = a.status === 201 ? walletA : walletB;
      const loser = a.status === 201 ? walletB : walletA;
      expect(await debitCount(winner.walletId)).toBe(1);
      expect(await debitCount(loser.walletId)).toBe(0);
      await api.assertLedgerConsistency(walletA.walletId);
      await api.assertLedgerConsistency(walletB.walletId);
    }
  });

  test('hot wallet: 60 operações mistas simultâneas nunca deixam saldo negativo e mantêm o ledger', async () => {
    const wallet = await api.createWallet('50.00');
    const operations = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? wager(wallet, 'WIN', '5.00') : wager(wallet, 'BET', '9.00'),
    );
    const responses = await Promise.all(operations.map((op) => api.submit(op)));
    expect(responses.every((r) => r.status === 201 || r.status === 422)).toBe(true);

    const processedBets = responses.filter((r, i) => operations[i]?.kind === 'BET' && r.status === 201).length;
    const wins = operations.filter((op) => op.kind === 'WIN').length;
    const expectedMinor = 5_000n + BigInt(wins) * 500n - BigInt(processedBets) * 900n;
    const [row] = await execute<{ balance: string }>(api.db, 'select balance_minor::text as balance from wallets where id = ?', [
      wallet.walletId,
    ]);
    expect(BigInt(row?.balance ?? '-1')).toBe(expectedMinor);
    expect(expectedMinor >= 0n).toBe(true);
    await api.assertLedgerConsistency(wallet.walletId);
  });
});
