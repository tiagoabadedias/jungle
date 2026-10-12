import { TransactionNotFoundError } from '../../shared/application/application-error.ts';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import type { FailureCode } from '../../shared/domain/failure-code.ts';
import type { MoneyProps } from '../../shared/domain/money.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind.ts';
import type { WagerTransactionStatus } from '../domain/wager-transaction-status.ts';

/** Resposta da submissão (§9). `balance` é o saldo observado na decisão, inclusive no replay (§7.7). */
export interface WagerTransactionResultView {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export function toResultView(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResultView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON(),
    idempotentReplay,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
  };
}

/** Representação completa para as consultas GET. */
export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceAttemptAt?: string;
  processedAt?: string;
  createdAt: string;
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    ...(tx.observedBalance === undefined ? {} : { balance: tx.observedBalance.toJSON() }),
    referenceAttempts: tx.referenceAttempts,
    ...(tx.nextReferenceAttemptAt === undefined ? {} : { nextReferenceAttemptAt: tx.nextReferenceAttemptAt.toISOString() }),
    ...(tx.processedAt === undefined ? {} : { processedAt: tx.processedAt.toISOString() }),
    createdAt: tx.createdAt.toISOString(),
  };
}

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run(({ transactions }) => transactions.findById(transactionId));
    if (tx === undefined) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run(({ transactions }) =>
      transactions.findByProviderExternalId(providerId, externalTransactionId),
    );
    if (tx === undefined) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}
