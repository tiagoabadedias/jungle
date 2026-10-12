import { EntitySchema } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { FailureCode } from '../../../shared/domain/failure-code.ts';
import { Money } from '../../../shared/domain/money.ts';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository.ts';
import { WagerTransaction } from '../../domain/wager-transaction.ts';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.ts';

/** Linha da tabela `wager_transactions`. */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  status!: string;
  amountMinor!: bigint;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  observedBalanceMinor!: bigint | null;
  observedBalanceCurrency!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  processedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'character', length: 64, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    status: { type: 'string' },
    amountMinor: { type: 'bigint', runtimeType: 'bigint', fieldName: 'amount_minor' },
    currency: { type: 'character', length: 3 },
    referenceExternalTransactionId: { type: 'string', nullable: true, fieldName: 'reference_external_transaction_id' },
    referenceTransactionId: { type: 'uuid', nullable: true, fieldName: 'reference_transaction_id' },
    failureCode: { type: 'string', nullable: true, fieldName: 'failure_code' },
    observedBalanceMinor: { type: 'bigint', runtimeType: 'bigint', nullable: true, fieldName: 'observed_balance_minor' },
    observedBalanceCurrency: { type: 'character', length: 3, nullable: true, fieldName: 'observed_balance_currency' },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: { type: 'datetime', nullable: true, fieldName: 'next_reference_attempt_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});

const KINDS = new Set<string>(Object.values(WagerTransactionKind));
const STATUSES = new Set<string>(Object.values(WagerTransactionStatus));
const FAILURE_CODES = new Set<string>(Object.values(FailureCode));

function parseEnum<T extends string>(value: string, allowed: Set<string>, label: string): T {
  if (!allowed.has(value)) throw new Error(`unknown ${label} "${value}"`);
  return value as T;
}

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: parseEnum<WagerTransactionKind>(record.kind, KINDS, 'kind'),
      money: Money.fromMinorUnits(record.amountMinor, record.currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: parseEnum<WagerTransactionStatus>(record.status, STATUSES, 'status'),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode:
        record.failureCode === null ? undefined : parseEnum<FailureCode>(record.failureCode, FAILURE_CODES, 'failure code'),
      processedAt: record.processedAt ?? undefined,
      observedBalance:
        record.observedBalanceMinor === null || record.observedBalanceCurrency === null
          ? undefined
          : Money.fromMinorUnits(record.observedBalanceMinor, record.observedBalanceCurrency),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
    });
  },

  /** Colunas que mudam ao longo do ciclo de vida (as demais são imutáveis no banco). */
  mutableColumns(tx: WagerTransaction) {
    return {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      observedBalanceMinor: tx.observedBalance?.minorUnits ?? null,
      observedBalanceCurrency: tx.observedBalance?.currency ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      processedAt: tx.processedAt ?? null,
    };
  },

  toRecord(tx: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
    return Object.assign(new WagerTransactionRecord(), {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amountMinor: tx.money.minorUnits,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      createdAt: tx.createdAt,
      updatedAt,
      ...WagerTransactionMapper.mutableColumns(tx),
    });
  },
};

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    const updatedAt = transaction.processedAt ?? transaction.createdAt;
    await this.em.insert(WagerTransactionSchema, WagerTransactionMapper.toRecord(transaction, updatedAt));
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' }, limit, disableIdentityMap: true },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async saveState(transaction: WagerTransaction, at: Date): Promise<void> {
    // Só linhas ainda não terminais no banco podem mudar (o trigger também garante).
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id, status: WagerTransactionStatus.PendingReference },
      { ...WagerTransactionMapper.mutableColumns(transaction), updatedAt: at },
    );
    if (affected !== 1) {
      throw new Error(`wager transaction ${transaction.id} is no longer pending in the database`);
    }
  }

  private async findOne(where: Partial<Pick<WagerTransactionRecord, 'id' | 'idempotencyKey' | 'providerId' | 'externalTransactionId'>>) {
    const record = await this.em.findOne(WagerTransactionSchema, where, { disableIdentityMap: true });
    return record === null ? undefined : WagerTransactionMapper.toDomain(record);
  }
}
