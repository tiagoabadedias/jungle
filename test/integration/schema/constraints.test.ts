import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectApp, connectOwner, execute, expectViolation, insert, migrateUp, SQLSTATE } from '../../helpers/database.ts';
import { hash, ledgerRow, seedProcessedBet, transactionRow, walletRow } from '../../helpers/rows.ts';

let owner: MikroORM;
let app: MikroORM;

beforeAll(async () => {
  owner = await connectOwner();
  await migrateUp(owner);
  app = await connectApp();
});

afterAll(async () => {
  await app.close(true);
  await owner.close(true);
});

async function newWallet(overrides = {}) {
  const wallet = walletRow(overrides);
  await insert(app, 'wallets', wallet);
  return String(wallet['id']);
}

describe('wallets', () => {
  test('uma wallet por player + moeda (§6.2)', async () => {
    const playerId = randomUUID();
    await newWallet({ player_id: playerId, currency: 'BRL' });
    await newWallet({ player_id: playerId, currency: 'USD' }); // outra moeda é permitida
    await expectViolation(
      insert(app, 'wallets', walletRow({ player_id: playerId, currency: 'BRL' })),
      SQLSTATE.uniqueViolation,
      'wallets_player_currency_uq',
    );
  });

  test('saldo nunca negativo, nem por UPDATE (§3, §5.9)', async () => {
    await expectViolation(
      insert(app, 'wallets', walletRow({ balance_minor: -1n })),
      SQLSTATE.checkViolation,
      'wallets_balance_non_negative_ck',
    );
    const id = await newWallet({ balance_minor: 1_000n });
    await expectViolation(
      execute(app, 'update wallets set balance_minor = balance_minor - 1001 where id = ?', [id]),
      SQLSTATE.checkViolation,
      'wallets_balance_non_negative_ck',
    );
  });

  test('moeda ISO-4217 e version >= 1', async () => {
    await expectViolation(insert(app, 'wallets', walletRow({ currency: 'brl' })), SQLSTATE.checkViolation, 'wallets_currency_format_ck');
    await expectViolation(insert(app, 'wallets', walletRow({ version: 0 })), SQLSTATE.checkViolation, 'wallets_version_positive_ck');
  });
});

describe('wager_transactions — idempotência e unicidade', () => {
  test('idempotency key única (§9)', async () => {
    const walletId = await newWallet();
    const key = `provider-a:${randomUUID()}`;
    await insert(app, 'wager_transactions', transactionRow(walletId, { idempotency_key: key }));
    await expectViolation(
      insert(app, 'wager_transactions', transactionRow(walletId, { idempotency_key: key })),
      SQLSTATE.uniqueViolation,
      'wager_transactions_idempotency_key_uq',
    );
  });

  test('(provider, id externo) único, mesmo com outra idempotency key', async () => {
    const walletId = await newWallet();
    const externalId = randomUUID();
    await insert(app, 'wager_transactions', transactionRow(walletId, { external_transaction_id: externalId }));
    await expectViolation(
      insert(app, 'wager_transactions', transactionRow(walletId, { external_transaction_id: externalId })),
      SQLSTATE.uniqueViolation,
      'wager_transactions_provider_external_uq',
    );
    // o mesmo id externo em outro provider é outra transação
    await insert(app, 'wager_transactions', transactionRow(walletId, { external_transaction_id: externalId, provider_id: 'provider-b' }));
  });

  test('wallet inexistente é rejeitada pela FK', async () => {
    await expectViolation(
      insert(app, 'wager_transactions', transactionRow(randomUUID())),
      SQLSTATE.foreignKeyViolation,
      'wager_transactions_wallet_fk',
    );
  });
});

describe('wager_transactions — regras de forma', () => {
  test.each([
    ['REFUND sem referência', { kind: 'REFUND' }, 'wager_transactions_reference_required_ck'],
    ['ROLLBACK sem referência', { kind: 'ROLLBACK' }, 'wager_transactions_reference_required_ck'],
    ['BET com referência', { reference_external_transaction_id: 'x', reference_transaction_id: null, status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }, 'wager_transactions_reference_allowed_ck'],
    ['referência em branco', { kind: 'WIN', reference_external_transaction_id: '  ', status: 'REJECTED', failure_code: 'REFERENCE_MISMATCH' }, 'wager_transactions_reference_not_blank_ck'],
    ['BET com valor zero', { amount_minor: 0n }, 'wager_transactions_amount_ck'],
    ['valor negativo', { amount_minor: -1n }, 'wager_transactions_amount_ck'],
    ['status PENDING persistido', { status: 'PENDING' }, 'wager_transactions_status_ck'],
    ['kind desconhecido', { kind: 'JACKPOT' }, 'wager_transactions_kind_ck'],
    ['REJECTED sem failure_code', { status: 'REJECTED' }, 'wager_transactions_failure_code_ck'],
    ['PROCESSED com failure_code', { failure_code: 'INSUFFICIENT_FUNDS' }, 'wager_transactions_failure_code_ck'],
    ['failure_code fora da taxonomia', { status: 'REJECTED', failure_code: 'OOPS' }, 'wager_transactions_failure_code_values_ck'],
    ['terminal sem processed_at', { processed_at: null }, 'wager_transactions_processed_at_ck'],
    ['PENDING_REFERENCE sem agendamento', { kind: 'REFUND', reference_external_transaction_id: 'b', status: 'PENDING_REFERENCE', processed_at: null }, 'wager_transactions_pending_schedule_ck'],
    ['PROCESSED com referência não resolvida', { kind: 'REFUND', reference_external_transaction_id: 'b' }, 'wager_transactions_processed_reference_resolved_ck'],
    ['saldo observado sem moeda', { observed_balance_currency: null }, 'wager_transactions_observed_balance_pair_ck'],
    ['saldo observado negativo', { observed_balance_minor: -1n }, 'wager_transactions_observed_balance_ck'],
    ['hash fora do formato SHA-256', { payload_hash: 'z'.repeat(64) }, 'wager_transactions_payload_hash_ck'],
    ['provider vazio', { provider_id: ' ' }, 'wager_transactions_text_fields_ck'],
  ])('%s → rejeitado', async (_, overrides, constraint) => {
    const walletId = await newWallet();
    await expectViolation(insert(app, 'wager_transactions', transactionRow(walletId, overrides)), SQLSTATE.checkViolation, constraint);
  });

  test('LOSS aceita valor zero', async () => {
    const walletId = await newWallet();
    await insert(app, 'wager_transactions', transactionRow(walletId, { kind: 'LOSS', amount_minor: 0n }));
  });

  test('saldo observado em moeda diferente da transação é aceito (rejeição CURRENCY_MISMATCH)', async () => {
    const walletId = await newWallet();
    await insert(
      app,
      'wager_transactions',
      transactionRow(walletId, { currency: 'USD', status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH', observed_balance_currency: 'BRL' }),
    );
  });
});

describe('wager_transactions — reversão única (§7.4)', () => {
  test('duas reversões PROCESSED da mesma BET são impossíveis, por qualquer kind', async () => {
    const { walletId, betId } = await seedProcessedBet(app);
    const reversal = (kind: string, overrides = {}) =>
      transactionRow(walletId, { kind, reference_external_transaction_id: 'bet', reference_transaction_id: betId, ...overrides });

    await insert(app, 'wager_transactions', reversal('REFUND'));
    await expectViolation(insert(app, 'wager_transactions', reversal('REFUND')), SQLSTATE.uniqueViolation, 'wager_transactions_single_reversal_uq');
    await expectViolation(insert(app, 'wager_transactions', reversal('ROLLBACK')), SQLSTATE.uniqueViolation, 'wager_transactions_single_reversal_uq');
    // tentativas rejeitadas continuam auditáveis
    await insert(app, 'wager_transactions', reversal('ROLLBACK', { status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED' }));
  });

  test('WIN referenciando a BET não conta como reversão', async () => {
    const { walletId, betId } = await seedProcessedBet(app);
    await insert(app, 'wager_transactions', transactionRow(walletId, { kind: 'WIN', reference_external_transaction_id: 'bet', reference_transaction_id: betId }));
    await insert(app, 'wager_transactions', transactionRow(walletId, { kind: 'REFUND', reference_external_transaction_id: 'bet', reference_transaction_id: betId }));
  });
});

describe('wager_transactions — imutabilidade (§6.3)', () => {
  test('linha terminal não pode ser alterada', async () => {
    const { betId } = await seedProcessedBet(app);
    await expectViolation(
      execute(app, `update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?`, [betId]),
      SQLSTATE.restrictViolation,
      'is terminal',
    );
  });

  test('PENDING_REFERENCE pode ser reagendada e depois decidida; campos de negócio nunca mudam', async () => {
    const walletId = await newWallet();
    const pending = transactionRow(walletId, {
      kind: 'REFUND',
      reference_external_transaction_id: 'late-bet',
      status: 'PENDING_REFERENCE',
      processed_at: null,
      next_reference_attempt_at: new Date('2026-07-29T15:00:02.000Z'),
    });
    await insert(app, 'wager_transactions', pending);
    const id = String(pending['id']);

    await execute(app, `update wager_transactions set reference_attempts = 1, next_reference_attempt_at = now() where id = ?`, [id]);
    await expectViolation(
      execute(app, `update wager_transactions set amount_minor = 1 where id = ?`, [id]),
      SQLSTATE.restrictViolation,
      'immutable',
    );
    await execute(
      app,
      `update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
         next_reference_attempt_at = null, processed_at = now() where id = ?`,
      [id],
    );
    await expectViolation(
      execute(app, `update wager_transactions set reference_attempts = 2 where id = ?`, [id]),
      SQLSTATE.restrictViolation,
      'is terminal',
    );
  });

  test('transações não podem ser apagadas, nem pela dona das tabelas', async () => {
    const { betId } = await seedProcessedBet(app);
    await expectViolation(execute(owner, 'delete from wager_transactions where id = ?', [betId]), SQLSTATE.restrictViolation, 'cannot be deleted');
  });
});

describe('wallet_ledger_entries (§6.4, §5.5)', () => {
  test('aritmética do lançamento: before ± amount = after', async () => {
    const { walletId } = await seedProcessedBet(app);
    const txId = String((await seedTx(walletId))['id']);
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, txId, { balance_after_minor: 97_501n })),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balanced_ck',
    );
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, txId, { direction: 'CREDIT' })),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balanced_ck',
    );
  });

  test('valor positivo e saldos não negativos', async () => {
    const { walletId } = await seedProcessedBet(app);
    const txId = String((await seedTx(walletId))['id']);
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, txId, { amount_minor: 0n, balance_after_minor: 100_000n })),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_amount_positive_ck',
    );
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, txId, { balance_before_minor: 1_000n, balance_after_minor: -1_500n })),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balances_non_negative_ck',
    );
  });

  test('no máximo um lançamento por transação por wallet', async () => {
    const { walletId, betId } = await seedProcessedBet(app);
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, betId)),
      SQLSTATE.uniqueViolation,
      'wallet_ledger_entries_transaction_wallet_uq',
    );
  });

  test('lançamento na moeda da wallet e da mesma wallet da transação (FKs compostas)', async () => {
    const { walletId, betId } = await seedProcessedBet(app);
    const otherWalletId = await newWallet();
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(walletId, String((await seedTx(walletId))['id']), { currency: 'USD' })),
      SQLSTATE.foreignKeyViolation,
      'wallet_ledger_entries_wallet_fk',
    );
    await expectViolation(
      insert(app, 'wallet_ledger_entries', ledgerRow(otherWalletId, betId)),
      SQLSTATE.foreignKeyViolation,
      'wallet_ledger_entries_transaction_fk',
    );
  });

  test('append-only: UPDATE, DELETE e TRUNCATE bloqueados mesmo para a dona das tabelas', async () => {
    const { entry } = await seedProcessedBet(app);
    const id = String(entry['id']);
    await expectViolation(execute(owner, 'update wallet_ledger_entries set amount_minor = 1 where id = ?', [id]), SQLSTATE.restrictViolation, 'append-only');
    await expectViolation(execute(owner, 'delete from wallet_ledger_entries where id = ?', [id]), SQLSTATE.restrictViolation, 'append-only');
    await expectViolation(execute(owner, 'truncate wallet_ledger_entries cascade'), SQLSTATE.restrictViolation, 'append-only');
    const rows = await execute(app, 'select 1 from wallet_ledger_entries where id = ?', [id]);
    expect(rows).toHaveLength(1);
  });
});

describe('inbox e outbox', () => {
  test('inbox: deduplicação por (consumer_name, message_id)', async () => {
    const messageId = `msg-${randomUUID()}`;
    const row = { consumer_name: 'wager-transactions', message_id: messageId, payload_hash: hash(), received_at: new Date() };
    await insert(app, 'inbox_messages', row);
    await insert(app, 'inbox_messages', { ...row, consumer_name: 'other-consumer' });
    await expectViolation(insert(app, 'inbox_messages', row), SQLSTATE.uniqueViolation, 'inbox_messages_pk');
  });

  test('inbox: ON CONFLICT DO NOTHING detecta redelivery sem abortar a transação', async () => {
    const row = { consumer_name: 'wager-transactions', message_id: `msg-${randomUUID()}`, payload_hash: hash(), received_at: new Date() };
    const sql = `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
                 values (?, ?, ?, ?) on conflict do nothing returning message_id`;
    const params = [row.consumer_name, row.message_id, row.payload_hash, row.received_at];
    expect(await execute(app, sql, params)).toHaveLength(1);
    expect(await execute(app, sql, params)).toHaveLength(0);
  });

  test('outbox: tipo de evento conhecido, payload objeto, attempts >= 0', async () => {
    const base = {
      id: randomUUID(),
      aggregate_id: randomUUID(),
      event_type: 'WalletBalanceChanged',
      payload: JSON.stringify({ eventId: 'e' }),
      occurred_at: new Date(),
      attempts: 0,
      next_attempt_at: new Date(),
    };
    await insert(app, 'outbox_messages', base);
    await expectViolation(insert(app, 'outbox_messages', { ...base, id: randomUUID(), event_type: 'Unknown' }), SQLSTATE.checkViolation, 'outbox_messages_event_type_ck');
    await expectViolation(insert(app, 'outbox_messages', { ...base, id: randomUUID(), payload: '[1]' }), SQLSTATE.checkViolation, 'outbox_messages_payload_object_ck');
    await expectViolation(insert(app, 'outbox_messages', { ...base, id: randomUUID(), attempts: -1 }), SQLSTATE.checkViolation, 'outbox_messages_attempts_ck');
  });
});

async function seedTx(walletId: string) {
  const tx = transactionRow(walletId);
  await insert(app, 'wager_transactions', tx);
  return tx;
}
