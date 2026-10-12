import { IdempotencyConflictError, MessageConflictError } from '../../../shared/application/application-error.ts';
import { errorCodeOf } from '../../../shared/application/error-message.ts';
import { assignLogContext } from '../../../shared/infrastructure/observability/log-context.ts';
import type { Metrics, Source } from '../../../shared/infrastructure/observability/metrics.ts';
import type { WagerTransactionResultView } from '../../application/wager-transaction-views.ts';
import { SUBMITTABLE_KINDS } from '../../domain/wager-transaction-kind.ts';

/** Label `kind` restrito aos valores conhecidos (entrada inválida não cria série nova). */
function kindLabel(kind: string): string {
  return SUBMITTABLE_KINDS.some((known) => known === kind) ? kind : 'INVALID';
}

/**
 * Registra o desfecho de uma submissão de aposta, igual para HTTP e SQS: contador por status,
 * duplicatas (replay idempotente), latência e o transactionId no contexto de log.
 */
export function recordWagerResult(
  metrics: Metrics,
  source: Source,
  kind: string,
  result: WagerTransactionResultView,
  seconds: number,
): void {
  assignLogContext({ transactionId: result.transactionId });
  metrics.transactions.inc({ status: result.status, kind: kindLabel(kind), source });
  if (result.idempotentReplay) metrics.duplicates.inc({ kind: 'idempotent_replay', source });
  metrics.processingDuration.observe({ source, outcome: result.status }, seconds);
}

export function recordWagerFailure(metrics: Metrics, source: Source, error: unknown, seconds: number): void {
  if (error instanceof IdempotencyConflictError) metrics.duplicates.inc({ kind: 'idempotency_conflict', source });
  if (error instanceof MessageConflictError) metrics.duplicates.inc({ kind: 'message_conflict', source });
  metrics.processingDuration.observe({ source, outcome: errorCodeOf(error) ?? 'ERROR' }, seconds);
}

/** Linha de log do desfecho, igual para HTTP e SQS (sem valores monetários, §12). */
export function logWagerHandled(logger: { log(message: unknown): void }, kind: string, result: WagerTransactionResultView): void {
  logger.log({
    msg: 'wager transaction handled',
    kind,
    status: result.status,
    failureCode: result.failureCode,
    idempotentReplay: result.idempotentReplay,
  });
}
