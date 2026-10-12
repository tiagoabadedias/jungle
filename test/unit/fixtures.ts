import { ExponentialBackoff } from '../../src/shared/domain/exponential-backoff.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';
import { Wallet } from '../../src/wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.ts';
import { computePayloadHash } from '../../src/wagering/domain/payload-hash.ts';
import {
  type CreateWagerTransactionProps,
  type ReferenceRetryPolicy,
  WagerTransaction,
} from '../../src/wagering/domain/wager-transaction.ts';
import type { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

let sequence = 0;
export function nextId(prefix = 'id'): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const referenceRetry: ReferenceRetryPolicy = {
  maxAttempts: 3,
  backoff: ExponentialBackoff.create({ baseDelayMs: 2_000, maxDelayMs: 300_000 }),
};

/** Wallet com saldo inicial e o lançamento de abertura correspondente. */
export function openWallet(amount: string, overrides: { id?: string; playerId?: string; currency?: string } = {}) {
  const currency = overrides.currency ?? 'BRL';
  const { wallet, openingEntry } = Wallet.open({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    initialBalance: Money.from({ amount, currency }),
    openingTransactionId: nextId('opening'),
    openingEntryId: nextId('entry'),
    at: NOW,
  });
  const ledger: WalletLedgerEntry[] = openingEntry === undefined ? [] : [openingEntry];
  return { wallet, ledger };
}

export interface TxOverrides extends Partial<Omit<CreateWagerTransactionProps, 'kind' | 'money'>> {
  currency?: string;
}

export function newTransaction(kind: WagerTransactionKind, amount: string, overrides: TxOverrides = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  const money = Money.from({ amount, currency: overrides.currency ?? 'BRL' });
  const fields = {
    providerId: overrides.providerId ?? PROVIDER_ID,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER_ID,
    walletId: overrides.walletId ?? WALLET_ID,
    roundId: overrides.roundId ?? ROUND_ID,
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    ...fields,
    id: overrides.id ?? nextId('tx'),
    idempotencyKey: overrides.idempotencyKey ?? `${fields.providerId}:${externalTransactionId}`,
    payloadHash: overrides.payloadHash ?? computePayloadHash(fields),
    money,
    createdAt: overrides.createdAt ?? NOW,
  });
}

/** Invariante global dos testes: saldo == saldo reconstruído pelo ledger (§13). */
export function ledgerBalance(entries: readonly WalletLedgerEntry[], currency = 'BRL'): Money {
  return entries.reduce(
    (total, entry) => (entry.direction === LedgerDirection.Credit ? total.add(entry.money) : total.subtract(entry.money)),
    Money.zero(currency),
  );
}
