import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connectOwner, execute } from '../../helpers/database.ts';
import { TestApp, wager } from '../../helpers/app.ts';

let api: TestApp;

beforeAll(async () => {
  api = await TestApp.start();
});

afterAll(async () => {
  await api.stop();
});

describe('POST /wallets', () => {
  test('cria a wallet com OPENING + CREDIT e eventos na outbox, tudo na mesma transação', async () => {
    const playerId = randomUUID();
    const response = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = String(response.body['id']);

    const opening = await execute<{ kind: string; status: string; amount_minor: string }>(
      api.db,
      `select kind, status, amount_minor::text from wager_transactions where wallet_id = ?`,
      [walletId],
    );
    expect(opening).toEqual([{ kind: 'OPENING', status: 'PROCESSED', amount_minor: '100000' }]);

    const events = await execute<{ event_type: string }>(
      api.db,
      `select event_type from outbox_messages where aggregate_id = ? order by event_type`,
      [walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await api.assertLedgerConsistency(walletId);
  });

  test('saldo inicial zero não gera OPENING, ledger nem eventos', async () => {
    const { walletId } = await api.createWallet('0.00');
    const rows = await execute(api.db, 'select 1 from wager_transactions where wallet_id = ?', [walletId]);
    expect(rows).toHaveLength(0);
    await api.assertLedgerConsistency(walletId);
  });

  test('wallet duplicada para o mesmo player + moeda → 409', async () => {
    const playerId = randomUUID();
    await api.createWallet('10.00', 'BRL', playerId);
    const duplicate = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body['code']).toBe('WALLET_ALREADY_EXISTS');
    await api.createWallet('5.00', 'USD', playerId); // outra moeda é outra wallet
  });

  test.each([
    ['amount number', { amount: 10, currency: 'BRL' }],
    ['amount com 3 casas', { amount: '10.005', currency: 'BRL' }],
    ['notação científica', { amount: '1e3', currency: 'BRL' }],
    ['negativo', { amount: '-1.00', currency: 'BRL' }],
    ['moeda inválida', { amount: '1.00', currency: 'real' }],
  ])('payload inválido (%s) → 400', async (_, initialBalance) => {
    const response = await api.request('POST', '/wallets', { playerId: randomUUID(), initialBalance });
    expect(response.status).toBe(400);
  });

  test('campos desconhecidos e playerId inválido → 400', async () => {
    expect((await api.request('POST', '/wallets', { playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } })).status).toBe(400);
    expect(
      (await api.request('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, admin: true }))
        .status,
    ).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  test('retorna saldo e version', async () => {
    const wallet = await api.createWallet('50.00');
    const response = await api.request('GET', `/wallets/${wallet.walletId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: wallet.walletId, balance: { amount: '50.00', currency: 'BRL' }, version: 1 });
  });

  test('inexistente → 404; id malformado → 400', async () => {
    expect((await api.request('GET', `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await api.request('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('X-Correlation-Id é devolvido (recebido ou gerado)', async () => {
    const wallet = await api.createWallet('1.00');
    const response = await api.request('GET', `/wallets/${wallet.walletId}`, undefined, { 'X-Correlation-Id': 'corr-abc-123' });
    expect(response.headers.get('x-correlation-id')).toBe('corr-abc-123');
  });
});

describe('GET /wallets/:walletId/ledger — cursor estável e opaco', () => {
  test('pagina todos os lançamentos em ordem, sem repetir nem pular', async () => {
    const wallet = await api.createWallet('100.00');
    for (let i = 0; i < 6; i += 1) {
      expect((await api.submit(wager(wallet, 'BET', '1.00'))).status).toBe(201);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '?limit=3' : `?limit=3&cursor=${cursor}`;
      const page = await api.request<{ entries: { id: string; balanceAfter: { amount: string } }[]; nextCursor: string | null }>(
        'GET',
        `/wallets/${wallet.walletId}/ledger${query}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e) => e.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7); // OPENING + 6 BETs
    expect(new Set(seen).size).toBe(7);
  });

  test('cursor adulterado e limit fora da faixa → 400', async () => {
    const wallet = await api.createWallet('1.00');
    expect((await api.request('GET', `/wallets/${wallet.walletId}/ledger?cursor=bm90LWpzb24`)).status).toBe(400);
    expect((await api.request('GET', `/wallets/${wallet.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await api.request('GET', `/wallets/${wallet.walletId}/ledger?limit=101`)).status).toBe(400);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet consistente', async () => {
    const wallet = await api.createWallet('100.00');
    await api.submit(wager(wallet, 'BET', '30.00'));
    const response = await api.request('POST', `/wallets/${wallet.walletId}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.walletId,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e NÃO corrigida', async () => {
    const wallet = await api.createWallet('100.00');
    // Corrupção proposital, fora da aplicação (dona das tabelas).
    const owner = await connectOwner();
    await execute(owner, 'update wallets set balance_minor = balance_minor + 500 where id = ?', [wallet.walletId]);
    await owner.close(true);

    const response = await api.request('POST', `/wallets/${wallet.walletId}/reconciliation`);
    expect(response.body).toMatchObject({
      storedBalance: { amount: '105.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '5.00' },
      consistent: false,
    });
    const after = await api.request('GET', `/wallets/${wallet.walletId}`);
    expect(after.body['balance']).toEqual({ amount: '105.00', currency: 'BRL' });
  });

  test('wallet inexistente → 404', async () => {
    expect((await api.request('POST', `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
  });
});
