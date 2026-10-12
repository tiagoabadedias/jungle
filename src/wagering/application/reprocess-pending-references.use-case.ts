import { TransientInfrastructureError } from '../../shared/application/application-error.ts';
import { eventContext, type RequestContext } from '../../shared/application/event-context-factory.ts';
import type { TransactionScope, UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Clock } from '../../shared/application/ports/clock.ts';
import type { IdGenerator } from '../../shared/application/ports/id-generator.ts';
import { settleWagerTransaction } from '../domain/wager-settlement.ts';
import type { ReferenceRetryPolicy } from '../domain/wager-transaction.ts';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.ts';
import { recordSettlementEffects } from './settlement-effects.ts';
import { errorMessage } from '../../shared/application/error-message.ts';

/**
 * PROCESSED/REJECTED/FAILED: decididas. RESCHEDULED: referência ainda ausente.
 * DEFERRED: falha transitória (fica vencida e volta no próximo ciclo). SKIPPED: já tratada.
 */
export type ReprocessOutcome = 'PROCESSED' | 'REJECTED' | 'FAILED' | 'RESCHEDULED' | 'DEFERRED' | 'SKIPPED';

/** Item efetivamente tratado (não ignorado), para log e métricas no adapter. */
export interface ReprocessedItem {
  transactionId: string;
  walletId: string;
  providerId: string;
  idempotencyKey: string;
  kind: string;
  outcome: Exclude<ReprocessOutcome, 'SKIPPED' | 'DEFERRED'>;
  failureCode?: string;
  /** Motivo técnico quando FAILED (para log; nunca vai para o provedor). */
  error?: string;
}

export interface ReprocessSummary {
  outcomes: Record<ReprocessOutcome, number>;
  items: ReprocessedItem[];
}

/**
 * Worker agendado de referências fora de ordem (§7.1). Para cada transação vencida, numa
 * transação SQL própria: trava a wallet PRIMEIRO e só então relê a transação — a mesma
 * ordem de locks do caminho HTTP/SQS, sem possibilidade de deadlock por inversão. Se outra
 * instância já tratou o item, a releitura não o encontra pendente e ele é ignorado.
 */
export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy,
    private readonly batchSize: number,
  ) {}

  async runOnce(): Promise<ReprocessSummary> {
    const due = await this.uow.run(({ transactions }) =>
      transactions.findDuePendingReferences(this.clock.now(), this.batchSize),
    );
    const outcomes: Record<ReprocessOutcome, number> = {
      PROCESSED: 0,
      REJECTED: 0,
      FAILED: 0,
      RESCHEDULED: 0,
      DEFERRED: 0,
      SKIPPED: 0,
    };
    const items: ReprocessedItem[] = [];
    for (const candidate of due) {
      // Cada item é isolado: um item problemático nunca impede o processamento dos demais.
      const item = await this.reprocessIsolated(candidate.id, candidate.walletId);
      if (item === 'SKIPPED' || item === 'DEFERRED') {
        outcomes[item] += 1;
      } else {
        outcomes[item.outcome] += 1;
        items.push(item);
      }
    }
    return { outcomes, items };
  }

  /**
   * Transitório (lock, banco indisponível): adia — a transação continua vencida e volta no
   * próximo ciclo. Qualquer outro erro é permanente: a transação vira FAILED com
   * INFRA_PERMANENT_FAILURE (terminal e auditável, §6.3), em vez de travar o worker num
   * item que falharia para sempre. Não há evento de integração para FAILED no §11.
   */
  private async reprocessIsolated(transactionId: string, walletId: string): Promise<ReprocessedItem | 'SKIPPED' | 'DEFERRED'> {
    try {
      return await this.uow.run((scope) => this.reprocess(scope, transactionId, walletId));
    } catch (error) {
      if (error instanceof TransientInfrastructureError) return 'DEFERRED';
      const reason = errorMessage(error);
      try {
        return await this.uow.run((scope) => this.markFailed(scope, transactionId, walletId, reason));
      } catch {
        return 'DEFERRED'; // nem marcar foi possível (ex.: banco caiu): tenta no próximo ciclo
      }
    }
  }

  private async markFailed(
    scope: TransactionScope,
    transactionId: string,
    walletId: string,
    reason: string,
  ): Promise<ReprocessedItem | 'SKIPPED'> {
    await scope.wallets.lockForUpdate(walletId); // mesma ordem de locks do caminho normal
    const transaction = await scope.transactions.findById(transactionId);
    if (transaction === undefined || transaction.status !== WagerTransactionStatus.PendingReference) return 'SKIPPED';
    const now = this.clock.now();
    transaction.fail(FailureCode.InfraPermanentFailure, now);
    await scope.transactions.saveState(transaction, now);
    return {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      idempotencyKey: transaction.idempotencyKey,
      kind: transaction.kind,
      outcome: 'FAILED',
      failureCode: FailureCode.InfraPermanentFailure,
      error: reason,
    };
  }

  private async reprocess(scope: TransactionScope, transactionId: string, walletId: string): Promise<ReprocessedItem | 'SKIPPED'> {
    const wallet = await scope.wallets.lockForUpdate(walletId);
    if (wallet === undefined) return 'SKIPPED';

    const now = this.clock.now();
    const transaction = await scope.transactions.findById(transactionId);
    const nextAttempt = transaction?.nextReferenceAttemptAt;
    if (
      transaction === undefined ||
      transaction.status !== WagerTransactionStatus.PendingReference ||
      (nextAttempt !== undefined && nextAttempt.getTime() > now.getTime())
    ) {
      return 'SKIPPED'; // já tratado por outra instância
    }

    const referenceId = transaction.referenceExternalTransactionId;
    const reference =
      referenceId === undefined ? undefined : await scope.transactions.findByProviderExternalId(transaction.providerId, referenceId);
    const referenceAlreadyReversed = reference === undefined ? false : await scope.transactions.hasProcessedReversal(reference.id);

    const versionBefore = wallet.version;
    const result = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now,
      referenceRetry: this.referenceRetry,
    });
    await scope.transactions.saveState(transaction, now);

    // Correlação com a requisição original: a idempotency key identifica a operação do provedor.
    const context: RequestContext = { correlationId: transaction.idempotencyKey, causationId: transaction.id };
    await recordSettlementEffects(scope, {
      transaction,
      wallet,
      versionBefore,
      result,
      nextEventContext: () => eventContext(this.ids, now, context),
      announcePendingReference: false, // reagendada: o evento de pendência já foi emitido na primeira vez
    });

    const outcome =
      result.outcome === WagerTransactionStatus.Processed
        ? 'PROCESSED'
        : result.outcome === WagerTransactionStatus.Rejected
          ? 'REJECTED'
          : 'RESCHEDULED';
    return {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      idempotencyKey: transaction.idempotencyKey,
      kind: transaction.kind,
      outcome,
      ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    };
  }
}
