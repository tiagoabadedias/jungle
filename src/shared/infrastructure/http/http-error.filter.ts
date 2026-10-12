import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { DriverException } from '@mikro-orm/core';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/application-error.ts';
import { InvalidMoneyError } from '../../domain/domain-error.ts';
import type { Metrics } from '../observability/metrics.ts';
import { errorMessage } from '../../application/error-message.ts';

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
  transactionId?: string;
}

interface HttpError {
  status: number;
  body: ErrorBody;
}

interface JsonResponse {
  status(code: number): JsonResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

/** Segundos sugeridos ao provedor antes de reenviar após uma falha transitória. */
const RETRY_AFTER_SECONDS = '1';

/**
 * Tradução única de erros → HTTP, igual em todos os endpoints (§9):
 *   400 payload inválido · 404 inexistente · 409 conflito (idempotência, wallet duplicada)
 *   503 falha transitória (retryable) · 500 erro de programação.
 * Rejeições de regra de negócio (422) e pendências (202) não são erros: o controller responde.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof InvalidRequestError || error instanceof InvalidMoneyError) {
    return { status: 400, body: { code: 'INVALID_REQUEST', message: error.message, retryable: false } };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, body: { code: error.code, message: error.message, retryable: false } };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: { code: error.code, message: error.message, retryable: false, transactionId: error.existingTransactionId },
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: { code: error.code, message: error.message, retryable: false } };
  }
  if (error instanceof TransientInfrastructureError) {
    return { status: 503, body: { code: error.code, message: 'temporarily unavailable, retry later', retryable: true } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const details = typeof response === 'object' && response !== null && 'message' in response ? response.message : undefined;
    return {
      status,
      body: {
        code: status === HttpStatus.BAD_REQUEST ? 'VALIDATION_ERROR' : HttpStatus[status] ?? 'HTTP_ERROR',
        message: status === HttpStatus.BAD_REQUEST ? 'request validation failed' : error.message,
        retryable: false,
        ...(details === undefined ? {} : { details }),
      },
    };
  }
  if ((error instanceof DriverException && error.code === '23001') || error instanceof UniqueViolationError) {
    // Trigger ou constraint do schema barrou uma escrita que a aplicação deveria ter evitado
    // (as unicidades esperadas — idempotência, wallet duplicada — já foram traduzidas antes). Bug.
    return { status: 500, body: { code: 'SCHEMA_GUARD_VIOLATION', message: 'internal error', retryable: false } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'internal error', retryable: false } };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(private readonly metrics?: Metrics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toHttpError(exception);
    if (body.code === 'SCHEMA_GUARD_VIOLATION') this.metrics?.schemaGuardViolations.inc();
    if (status >= 500) {
      this.logger.error(
        { code: body.code, error: errorMessage(exception) },
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    const response = host.switchToHttp().getResponse<JsonResponse>();
    if (status === 503) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    response.status(status).json(body);
  }
}
