import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import type { EventContext } from '../../../src/shared/domain/integration-event.ts';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction.ts';
import { WalletBalanceChanged } from '../../../src/wallet/domain/events/wallet-balance-changed.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/wagering/domain/events/wager-transaction-events.ts';
import { WagerTransactionKind as Kind } from '../../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../../src/wagering/domain/wager-transaction-status.ts';
import { brl, newTransaction, NOW, nextId, openWallet, WALLET_ID } from '../fixtures.ts';

const ctx = (overrides: Partial<EventContext> = {}): EventContext => ({
  eventId: nextId('evt'),
  correlationId: 'corr-1',
  causationId: 'msg-123',
  occurredAt: NOW,
  ...overrides,
});

describe('IntegrationEvent — envelope', () => {
  test('WalletBalanceChanged: eventType/version no tipo e data com MoneyProps', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', entryId: 'e-1', at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, ctx({ eventId: 'evt-1' }));
    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      correlationId: 'corr-1',
      causationId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('causationId ausente é omitido do envelope; payload é JSON estável', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.markProcessed(undefined, NOW, brl('75.00'));
    const envelope = WagerTransactionProcessed.from(tx, ctx({ causationId: undefined })).toJSON();
    expect('causationId' in envelope).toBe(false);
    expect(() => JSON.stringify(envelope)).not.toThrow(); // nenhum bigint vaza
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test('data é congelada', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.markProcessed(undefined, NOW, brl('75.00'));
    expect(Object.isFrozen(WagerTransactionProcessed.from(tx, ctx()).data)).toBe(true);
  });

  test('WalletBalanceChanged rejeita lançamento de outra wallet', () => {
    const { wallet } = openWallet('100.00');
    const other = openWallet('100.00', { id: 'other-wallet' }).wallet;
    const entry = other.debit({ money: brl('1.00'), transactionId: 't', entryId: 'e', at: NOW });
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx())).toThrow(InvariantViolationError);
  });
});

describe('eventos de transação', () => {
  test('WagerTransactionProcessed (inclusive LOSS) carrega status, saldo e referência', () => {
    const loss = newTransaction(Kind.Loss, '0.00');
    loss.markProcessed('bet-id', NOW, brl('90.00'));
    const { data, eventType, aggregateId } = WagerTransactionProcessed.from(loss, ctx());
    expect(eventType).toBe('WagerTransactionProcessed');
    expect(aggregateId).toBe(WALLET_ID);
    expect(data.kind).toBe(Kind.Loss);
    expect(data.status).toBe(WagerTransactionStatus.Processed);
    expect(data.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(data.referenceTransactionId).toBe('bet-id');
  });

  test('WagerTransactionRejected carrega failureCode', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    tx.reject(FailureCode.InsufficientFunds, NOW, brl('10.00'));
    const event = WagerTransactionRejected.from(tx, ctx());
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('WagerTransactionPendingReference carrega a referência e o próximo reprocessamento', () => {
    const tx = newTransaction(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(brl('100.00'), new Date(NOW.getTime() + 2_000));
    const event = WagerTransactionPendingReference.from(tx, ctx());
    expect(event.data.referenceExternalTransactionId).toBe('bet-1');
    expect(event.data.nextAttemptAt).toBe('2026-07-29T15:00:02.000Z');
  });

  test('evento incompatível com o status da transação é erro de programação', () => {
    const tx = newTransaction(Kind.Bet, '25.00');
    expect(() => WagerTransactionProcessed.from(tx, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(tx, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(tx, ctx())).toThrow(InvariantViolationError);
  });
});
