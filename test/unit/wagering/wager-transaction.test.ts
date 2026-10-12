import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvariantViolationError } from '../../../src/shared/domain/domain-error.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction.ts';
import { INTERNAL_PROVIDER_ID, WagerTransaction } from '../../../src/wagering/domain/wager-transaction.ts';
import { WagerTransactionKind as Kind } from '../../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus as Status } from '../../../src/wagering/domain/wager-transaction-status.ts';
import { brl, newTransaction, NOW, PLAYER_ID, referenceRetry, WALLET_ID } from '../fixtures.ts';

const later = new Date(NOW.getTime() + 5_000);

describe('WagerTransaction.create', () => {
  test('nasce em PENDING', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => newTransaction(Kind.Opening, '25.00')).toThrow(InvariantViolationError);
  });

  test.each([[Kind.Refund], [Kind.Rollback]])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => newTransaction(kind, '25.00')).toThrow(InvariantViolationError);
    expect(() => newTransaction(kind, '25.00', { referenceExternalTransactionId: '' })).toThrow(InvariantViolationError);
    expect(newTransaction(kind, '25.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test.each([
    [Kind.Bet, ''],
    [Kind.Bet, '  '],
    [Kind.Win, ''],
    [Kind.Win, '  '],
    [Kind.Refund, '  '],
  ])('%s com referência vazia ("%s") é payload inválido, nunca aguarda referência', (kind, reference) => {
    expect(() => newTransaction(kind, '1.00', { referenceExternalTransactionId: reference })).toThrow(InvariantViolationError);
  });

  test('WIN aceita referência opcional', () => {
    expect(newTransaction(Kind.Win, '10.00').hasReference()).toBe(false);
    expect(newTransaction(Kind.Win, '10.00', { referenceExternalTransactionId: 'bet-1' }).hasReference()).toBe(true);
  });

  test.each([[Kind.Bet], [Kind.Loss]])('%s não aceita referência', (kind) => {
    expect(() => newTransaction(kind, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvariantViolationError);
  });

  test.each([[Kind.Bet], [Kind.Win], [Kind.Refund], [Kind.Rollback]])('%s com valor 0.00 é inválido', (kind) => {
    expect(() => newTransaction(kind, '0.00', { referenceExternalTransactionId: 'ref' })).toThrow(InvariantViolationError);
  });

  test('LOSS aceita 0.00', () => {
    expect(newTransaction(Kind.Loss, '0.00').money.isZero()).toBe(true);
  });
});

describe('WagerTransaction — transições', () => {
  test('PENDING → PROCESSED guarda referência, data e saldo observado', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.markProcessed(undefined, later, brl('975.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(later);
    expect(tx.observedBalance?.toJSON().amount).toBe('975.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED guarda failureCode e saldo observado', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.reject(FailureCode.InsufficientFunds, later, brl('10.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.toJSON().amount).toBe('10.00');
  });

  test('PENDING → FAILED', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.fail(FailureCode.InfraPermanentFailure, later);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfraPermanentFailure);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, later, brl('1.00'))],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, later, brl('1.00'))],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InfraPermanentFailure, later)],
  ])('%s é terminal: qualquer transição lança InvalidTransactionStateError', (_, toTerminal) => {
    const tx = newTransaction(Kind.Bet, '25.00');
    toTerminal(tx);
    expect(() => tx.markProcessed(undefined, later, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, later, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfraPermanentFailure, later)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(brl('1.00'), later)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = newTransaction(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(brl('975.00'), later);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceAttemptAt).toEqual(later);
    expect(() => tx.markPendingReference(brl('975.00'), later)).toThrow(InvalidTransactionStateError);
    tx.markProcessed('bet-internal-id', later, brl('1000.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('bet-internal-id');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('registerReferenceAttempt reagenda com backoff e rejeita com REFERENCE_NOT_FOUND ao esgotar', () => {
    const tx = newTransaction(Kind.Rollback, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.registerReferenceAttempt(NOW, referenceRetry, brl('1.00'))).toThrow(InvalidTransactionStateError);
    tx.markPendingReference(brl('1.00'), NOW);

    expect(tx.registerReferenceAttempt(NOW, referenceRetry, brl('1.00'))).toBe('SCHEDULED');
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 4_000)); // 2s · 2¹

    expect(tx.registerReferenceAttempt(NOW, referenceRetry, brl('1.00'))).toBe('SCHEDULED');
    expect(tx.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 8_000)); // 2s · 2²

    expect(tx.registerReferenceAttempt(NOW, referenceRetry, brl('1.00'))).toBe('EXHAUSTED'); // maxAttempts = 3
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é false somente para LOSS', () => {
    expect(newTransaction(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(newTransaction(Kind.Bet, '1.00').affectsBalance()).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    const tx = newTransaction(Kind.Bet, '1.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test('ledgerDirectionFor por kind; ROLLBACK inverte a referência', () => {
    const bet = newTransaction(Kind.Bet, '10.00');
    const win = newTransaction(Kind.Win, '10.00');
    const refund = newTransaction(Kind.Refund, '10.00', { referenceExternalTransactionId: 'b' });
    const rollback = newTransaction(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'b' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => newTransaction(Kind.Loss, '0.00').ledgerDirectionFor()).toThrow(InvariantViolationError);
  });
});

describe('WagerTransaction.opening', () => {
  test('transação interna nasce PROCESSED, com provider interno e hash SHA-256', () => {
    const tx = WagerTransaction.opening({ id: 'open-1', walletId: WALLET_ID, playerId: PLAYER_ID, money: brl('1000.00'), at: NOW });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.idempotencyKey).toBe(`internal:opening:${WALLET_ID}`);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.observedBalance?.toJSON().amount).toBe('1000.00');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('exige valor positivo', () => {
    expect(() =>
      WagerTransaction.opening({ id: 'o', walletId: WALLET_ID, playerId: PLAYER_ID, money: brl('0.00'), at: NOW }),
    ).toThrow(InvariantViolationError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói estado terminal sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'e-1',
      idempotencyKey: 'provider-a:e-1',
      payloadHash: 'h',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('5.00'),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      processedAt: later,
      observedBalance: brl('1.00'),
      referenceAttempts: 0,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toEqual(later);
  });
});
