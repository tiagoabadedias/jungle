import { EntitySchema, LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/domain/money.ts';
import type { LedgerCursor, LedgerPage, LedgerRepository, LedgerTotals } from '../../application/ports/ledger.repository.ts';
import type { WalletRepository } from '../../application/ports/wallet.repository.ts';
import { LedgerDirection } from '../../domain/ledger-direction.ts';
import { Wallet } from '../../domain/wallet.ts';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';

// ------------------------------------------------------------------ records + schemas

/** Linha da tabela `wallets`. Dinheiro em bigint (unidades menores), nunca number. */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceMinor!: bigint;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'character', length: 3 },
    balanceMinor: { type: 'bigint', runtimeType: 'bigint', fieldName: 'balance_minor' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});

/** Linha da tabela `wallet_ledger_entries` (append-only). */
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amountMinor!: bigint;
  currency!: string;
  balanceBeforeMinor!: bigint;
  balanceAfterMinor!: bigint;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amountMinor: { type: 'bigint', runtimeType: 'bigint', fieldName: 'amount_minor' },
    currency: { type: 'character', length: 3 },
    balanceBeforeMinor: { type: 'bigint', runtimeType: 'bigint', fieldName: 'balance_before_minor' },
    balanceAfterMinor: { type: 'bigint', runtimeType: 'bigint', fieldName: 'balance_after_minor' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});

// ------------------------------------------------------------------------- mappers

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.fromMinorUnits(record.balanceMinor, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
  toRecord(wallet: Wallet): WalletRecord {
    return Object.assign(new WalletRecord(), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceMinor: wallet.balance.minorUnits,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const money = (minor: bigint) => Money.fromMinorUnits(minor, record.currency);
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: parseDirection(record.direction),
      money: money(record.amountMinor),
      balanceBefore: money(record.balanceBeforeMinor),
      balanceAfter: money(record.balanceAfterMinor),
      createdAt: record.createdAt,
    });
  },
  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return Object.assign(new LedgerEntryRecord(), {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amountMinor: entry.money.minorUnits,
      currency: entry.money.currency,
      balanceBeforeMinor: entry.balanceBefore.minorUnits,
      balanceAfterMinor: entry.balanceAfter.minorUnits,
      createdAt: entry.createdAt,
    });
  },
};

function parseDirection(value: string): LedgerDirection {
  if (value === LedgerDirection.Credit || value === LedgerDirection.Debit) return value;
  throw new Error(`unknown ledger direction "${value}"`);
}

// --------------------------------------------------------------------- repositories

/**
 * Leituras sem identity map e escritas explícitas (insert/nativeUpdate): o flush da
 * transação nunca gera UPDATE implícito de algo que só foi lido.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockForUpdate(walletId: string): Promise<Wallet | undefined> {
    return this.load(walletId, LockMode.PESSIMISTIC_WRITE);
  }

  async lockForShare(walletId: string): Promise<Wallet | undefined> {
    return this.load(walletId, LockMode.PESSIMISTIC_READ);
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    return this.load(walletId, undefined);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balanceMinor: wallet.balance.minorUnits, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      // Com a linha travada isso não acontece; se acontecer, é bug — aborta a transação.
      throw new Error(`wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
    }
  }

  private async load(walletId: string, lockMode: LockMode | undefined): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { ...(lockMode === undefined ? {} : { lockMode }), disableIdentityMap: true },
    );
    return record === null ? undefined : WalletMapper.toDomain(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<LedgerPage> {
    const where =
      after === undefined
        ? { walletId }
        : {
            walletId,
            $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }],
          };
    const records = await this.em.find(LedgerEntrySchema, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: limit + 1,
      disableIdentityMap: true,
    });
    const pageRecords = records.slice(0, limit);
    const last = pageRecords.at(-1);
    return {
      entries: pageRecords.map((record) => LedgerEntryMapper.toDomain(record)),
      next: records.length > limit && last !== undefined ? { createdAt: last.createdAt, id: last.id } : undefined,
    };
  }

  async totals(walletId: string): Promise<LedgerTotals> {
    // sum(bigint) é numeric e NULL sem linhas: coalesce + ::text, convertido para bigint sem passar por number.
    const [row] = await this.em.execute<{ balance: string; entries: number }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount_minor else -amount_minor end), 0)::text as balance,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    return { balanceMinor: BigInt(row?.balance ?? '0'), entries: row?.entries ?? 0 };
  }
}
