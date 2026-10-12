import { describe, expect, test } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/shared/application/application-error.ts';
import { toHttpError } from '../../src/shared/infrastructure/http/http-error.filter.ts';
import { httpStatusFor } from '../../src/wagering/infrastructure/http/wagering.controller.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';

describe('mapeamento consistente de erros → HTTP (§9)', () => {
  test.each([
    ['payload inválido', new InvalidRequestError('x'), 400, false],
    ['validação de DTO', new BadRequestException(['amount must be…']), 400, false],
    ['wallet inexistente', new WalletNotFoundError('w'), 404, false],
    ['transação inexistente', new TransactionNotFoundError('t'), 404, false],
    ['conflito de idempotência', new IdempotencyConflictError('x', 'tx'), 409, false],
    ['wallet duplicada', new WalletAlreadyExistsError('p', 'BRL'), 409, false],
    ['falha transitória', new TransientInfrastructureError('db down'), 503, true],
    ['erro inesperado', new Error('boom'), 500, false],
  ])('%s → %p (retryable: %p)', (_, error, status, retryable) => {
    const mapped = toHttpError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.retryable).toBe(retryable);
  });

  test('constraint inesperada do schema → 500 SCHEMA_GUARD_VIOLATION (distinto de erro genérico)', () => {
    const mapped = toHttpError(new UniqueViolationError('wager_transactions_single_reversal_uq'));
    expect(mapped.status).toBe(500);
    expect(mapped.body.code).toBe('SCHEMA_GUARD_VIOLATION');
  });

  test('erro inesperado não vaza mensagem interna', () => {
    expect(toHttpError(new Error('password=secret')).body.message).toBe('internal error');
  });

  test('status do resultado da transação', () => {
    expect(httpStatusFor(WagerTransactionStatus.Processed)).toBe(201);
    expect(httpStatusFor(WagerTransactionStatus.PendingReference)).toBe(202);
    expect(httpStatusFor(WagerTransactionStatus.Rejected)).toBe(422);
    expect(httpStatusFor(WagerTransactionStatus.Failed)).toBe(500);
  });
});
