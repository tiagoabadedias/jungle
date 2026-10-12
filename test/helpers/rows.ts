import { createHash, randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { insert, type Row } from './database.ts';

/**
 * Construtores de linhas válidas para os testes de schema. Todo identificador é aleatório,
 * para que reexecuções contra o mesmo banco não colidam nas constraints de unicidade.
 */
const NOW = new Date('2026-07-29T15:00:00.000Z');

export const hash = (value: string = randomUUID()): string => createHash('sha256').update(value).digest('hex');

export function walletRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance_minor: 100_000n,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function transactionRow(walletId: string, overrides: Row = {}): Row {
  const externalTransactionId = randomUUID();
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externalTransactionId,
    idempotency_key: `provider-a:${externalTransactionId}`,
    payload_hash: hash(),
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: 'round-987',
    game_id: 'fortune-chimp',
    kind: 'BET',
    status: 'PROCESSED',
    amount_minor: 2_500n,
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    failure_code: null,
    observed_balance_minor: 97_500n,
    observed_balance_currency: 'BRL',
    reference_attempts: 0,
    next_reference_attempt_at: null,
    processed_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function ledgerRow(walletId: string, transactionId: string, overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount_minor: 2_500n,
    currency: 'BRL',
    balance_before_minor: 100_000n,
    balance_after_minor: 97_500n,
    created_at: NOW,
    ...overrides,
  };
}

/** Wallet + BET processada + lançamento correspondente, já gravados. */
export async function seedProcessedBet(orm: MikroORM) {
  const wallet = walletRow();
  const bet = transactionRow(String(wallet['id']), { external_transaction_id: `bet-${randomUUID()}` });
  const entry = ledgerRow(String(wallet['id']), String(bet['id']));
  await insert(orm, 'wallets', wallet);
  await insert(orm, 'wager_transactions', bet);
  await insert(orm, 'wallet_ledger_entries', entry);
  return { wallet, bet, entry, walletId: String(wallet['id']), betId: String(bet['id']) };
}
