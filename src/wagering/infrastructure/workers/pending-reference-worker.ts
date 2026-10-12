import { Logger } from '@nestjs/common';
import { runWithLogContext } from '../../../shared/infrastructure/observability/log-context.ts';
import type { Metrics } from '../../../shared/infrastructure/observability/metrics.ts';
import { PollingWorker } from '../../../shared/infrastructure/workers/polling-worker.ts';
import type {
  ReprocessPendingReferencesUseCase,
  ReprocessSummary,
} from '../../application/reprocess-pending-references.use-case.ts';

/** Worker agendado de referências fora de ordem (§7.1): um tick = um lote do use case. */
export function createPendingReferenceWorker(
  useCase: ReprocessPendingReferencesUseCase,
  pollIntervalMs: number,
  metrics: Metrics,
): PollingWorker {
  const logger = new Logger('PendingReferenceWorker');
  return new PollingWorker(
    'pending-references',
    pollIntervalMs,
    async () => {
      const summary = await useCase.runOnce();
      report(summary, logger, metrics);
      // Itens reagendados não são progresso: evita girar sem dormir enquanto só há pendências futuras.
      return summary.outcomes.PROCESSED + summary.outcomes.REJECTED + summary.outcomes.FAILED;
    },
    logger,
  );
}

/** Logs (uma linha por transação, com os ids no contexto, como no HTTP/SQS) e métricas do lote. */
function report(summary: ReprocessSummary, logger: Logger, metrics: Metrics): void {
  for (const item of summary.items) {
    runWithLogContext(
      { correlationId: item.idempotencyKey, transactionId: item.transactionId, walletId: item.walletId, providerId: item.providerId },
      () =>
        item.outcome === 'FAILED'
          ? logger.error({ msg: 'pending reference failed permanently', kind: item.kind, error: item.error })
          : logger.log({ msg: 'pending reference handled', kind: item.kind, outcome: item.outcome, failureCode: item.failureCode }),
    );
    if (item.outcome !== 'RESCHEDULED') {
      metrics.transactions.inc({ status: item.outcome, kind: item.kind, source: 'worker' });
    }
  }
  for (const [outcome, count] of Object.entries(summary.outcomes)) {
    if (count > 0) metrics.pendingReferenceOutcomes.inc({ outcome }, count);
  }
  if (summary.outcomes.RESCHEDULED > 0) {
    metrics.retries.inc({ component: 'pending_reference', reason: 'REFERENCE_MISSING' }, summary.outcomes.RESCHEDULED);
  }
  if (summary.outcomes.DEFERRED > 0) {
    metrics.retries.inc({ component: 'pending_reference', reason: 'TRANSIENT_FAILURE' }, summary.outcomes.DEFERRED);
  }
}
