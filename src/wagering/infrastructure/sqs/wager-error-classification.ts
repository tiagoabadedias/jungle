import {
  IdempotencyConflictError,
  InvalidRequestError,
  MessageConflictError,
  WalletNotFoundError,
} from '../../../shared/application/application-error.ts';
import { errorCodeOf } from '../../../shared/application/error-message.ts';
import { DomainError } from '../../../shared/domain/domain-error.ts';
import { InvalidMessageError } from './wager-transaction-message.ts';

export type ErrorKind = 'PERMANENT' | 'TRANSIENT';

/**
 * Erros que nunca se resolvem reenviando a mesma mensagem (§10 "permanentes"): DLQ.
 * Rejeições de regra de negócio não são erros — o use case devolve REJECTED e a mensagem é
 * confirmada (§10 "negócio: terminal, ack"). Todo o resto é tratado como transitório e
 * retentado com backoff até o limite de tentativas.
 */
export function classifyError(error: unknown): ErrorKind {
  if (
    error instanceof InvalidMessageError ||
    error instanceof InvalidRequestError ||
    error instanceof DomainError ||
    error instanceof IdempotencyConflictError ||
    error instanceof MessageConflictError ||
    error instanceof WalletNotFoundError
  ) {
    return 'PERMANENT';
  }
  return 'TRANSIENT';
}

/** Código do erro para o motivo de retry/DLQ e para as métricas (nunca a mensagem, que pode ter dados). */
export function errorCode(error: unknown): string {
  return errorCodeOf(error) ?? (error instanceof Error ? error.name : 'UNKNOWN_ERROR');
}
