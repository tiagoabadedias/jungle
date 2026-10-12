import type { RequestContext } from '../../shared/application/event-context-factory.ts';
import type { ProcessWagerTransactionCommand } from '../application/process-wager-transaction.use-case.ts';
import type { SubmitWagerTransactionDto } from './http/wagering.dto.ts';

/**
 * Submissão (corpo HTTP ou `data` da mensagem SQS, que estende o mesmo DTO) → comando do use
 * case único (§10). `money` é copiado campo a campo: só o contrato chega ao domínio.
 */
export function toProcessCommand(
  submission: SubmitWagerTransactionDto,
  idempotencyKey: string,
  context: RequestContext,
  inbox?: ProcessWagerTransactionCommand['inbox'],
): ProcessWagerTransactionCommand {
  return {
    idempotencyKey,
    providerId: submission.providerId,
    externalTransactionId: submission.externalTransactionId,
    playerId: submission.playerId,
    walletId: submission.walletId,
    roundId: submission.roundId,
    gameId: submission.gameId,
    kind: submission.kind,
    money: { amount: submission.money.amount, currency: submission.money.currency },
    referenceExternalTransactionId: submission.referenceExternalTransactionId,
    context,
    ...(inbox === undefined ? {} : { inbox }),
  };
}
