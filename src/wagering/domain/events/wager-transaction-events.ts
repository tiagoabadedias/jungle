import { InvariantViolationError } from '../../../shared/domain/domain-error.ts';
import type { FailureCode } from '../../../shared/domain/failure-code.ts';
import { type EventContext, IntegrationEvent } from '../../../shared/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared/domain/money.ts';
import type { WagerTransaction } from '../wager-transaction.ts';
import type { WagerTransactionKind } from '../wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../wager-transaction-status.ts';

/**
 * Os eventos usam a wallet como aggregateId: ela é a unidade de concorrência (§8) e vira o
 * `MessageGroupId` no broker. Com vários publishers, a ordem entre eventos da mesma wallet
 * não é garantida (ARCHITECTURE §9); o consumidor ordena por `walletVersion`.
 */
interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  balance: MoneyProps;
}

function baseData(transaction: WagerTransaction): WagerTransactionEventData {
  const balance = transaction.observedBalance;
  if (balance === undefined) {
    throw new InvariantViolationError(`transaction ${transaction.id} has no observed balance`);
  }
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    balance: balance.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvariantViolationError(`expected transaction ${transaction.id} to be ${expected}, got ${transaction.status}`);
  }
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (§11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    const processedAt = transaction.processedAt ?? ctx.occurredAt;
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio, inclusive referência expirada (§7.1, §11). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) {
      throw new InvariantViolationError(`rejected transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: { ...baseData(transaction), failureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Referência ausente: a transação aguarda reprocessamento (§7.8, §11). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    const reference = transaction.referenceExternalTransactionId;
    const nextAttemptAt = transaction.nextReferenceAttemptAt;
    if (reference === undefined || nextAttemptAt === undefined) {
      throw new InvariantViolationError(`pending transaction ${transaction.id} lacks reference scheduling data`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: { ...baseData(transaction), referenceExternalTransactionId: reference, nextAttemptAt: nextAttemptAt.toISOString() },
    });
  }
}
