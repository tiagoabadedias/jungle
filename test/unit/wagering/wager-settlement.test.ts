import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/shared/domain/domain-error.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction.ts';
import type { Wallet } from '../../../src/wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry.ts';
import { type SettlementResult, settleWagerTransaction } from '../../../src/wagering/domain/wager-settlement.ts';
import type { WagerTransaction } from '../../../src/wagering/domain/wager-transaction.ts';
import { WagerTransactionKind as Kind } from '../../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus as Status } from '../../../src/wagering/domain/wager-transaction-status.ts';
import { brl, ledgerBalance, newTransaction, NOW, nextId, openWallet, referenceRetry, type TxOverrides } from '../fixtures.ts';

/**
 * Simula a wallet persistida + ledger + transações conhecidas, resolvendo referências por
 * (providerId, externalTransactionId) e reversões já processadas — o que o use case fará via repositório.
 */
class Book {
  readonly ledger: WalletLedgerEntry[];
  readonly transactions: WagerTransaction[] = [];

  constructor(
    readonly wallet: Wallet,
    ledger: WalletLedgerEntry[],
  ) {
    this.ledger = ledger;
  }

  static open(amount: string): Book {
    const { wallet, ledger } = openWallet(amount);
    return new Book(wallet, ledger);
  }

  submit(kind: Kind, amount: string, overrides: TxOverrides = {}): { tx: WagerTransaction; result: SettlementResult } {
    const tx = newTransaction(kind, amount, overrides);
    const result = this.settle(tx);
    this.transactions.push(tx);
    return { tx, result };
  }

  settle(tx: WagerTransaction, at = NOW): SettlementResult {
    const reference = this.transactions.find(
      (candidate) =>
        candidate.providerId === tx.providerId && candidate.externalTransactionId === tx.referenceExternalTransactionId,
    );
    const referenceAlreadyReversed =
      reference !== undefined &&
      this.transactions.some(
        (candidate) =>
          candidate.isReversal() && candidate.status === Status.Processed && candidate.referenceTransactionId === reference.id,
      );
    const result = settleWagerTransaction({
      transaction: tx,
      wallet: this.wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: nextId('entry'),
      at,
      referenceRetry,
    });
    if (result.outcome === Status.Processed && result.ledgerEntry !== undefined) {
      this.ledger.push(result.ledgerEntry);
    }
    return result;
  }

  balance(): string {
    return this.wallet.balance.toJSON().amount;
  }

  /** Invariante final (§13): saldo == saldo reconstruído pelo ledger. */
  assertConsistent(): void {
    expect(this.wallet.balance.equals(ledgerBalance(this.ledger))).toBe(true);
  }
}

describe('BET', () => {
  test('debita, gera 1 DEBIT e marca PROCESSED com o saldo observado', () => {
    const book = Book.open('1000.00');
    const { tx, result } = book.submit(Kind.Bet, '25.00');
    expect(result.outcome).toBe(Status.Processed);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.observedBalance?.toJSON().amount).toBe('975.00');
    expect(book.balance()).toBe('975.00');
    expect(book.ledger.at(-1)?.direction).toBe(LedgerDirection.Debit);
    expect(book.wallet.version).toBe(2);
    book.assertConsistent();
  });

  test('saldo insuficiente → REJECTED INSUFFICIENT_FUNDS, sem ledger e sem alterar saldo', () => {
    const book = Book.open('10.00');
    const { tx, result } = book.submit(Kind.Bet, '10.01');
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(tx.observedBalance?.toJSON().amount).toBe('10.00');
    expect(book.ledger).toHaveLength(1); // só o OPENING
    expect(book.wallet.version).toBe(1);
    book.assertConsistent();
  });

  test('cenário do §8 em sequência: 100.00 e duas apostas de 80.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito', () => {
    const book = Book.open('100.00');
    const first = book.submit(Kind.Bet, '80.00');
    const second = book.submit(Kind.Bet, '80.00');
    expect(first.tx.status).toBe(Status.Processed);
    expect(second.tx.status).toBe(Status.Rejected);
    expect(second.tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(book.balance()).toBe('20.00');
    expect(book.ledger.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
    book.assertConsistent();
  });
});

describe('WIN', () => {
  test('credita e gera 1 CREDIT', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Win, '50.00');
    expect(book.balance()).toBe('150.00');
    expect(book.ledger.at(-1)?.direction).toBe(LedgerDirection.Credit);
    book.assertConsistent();
  });

  test('pode referenciar a BET da mesma rodada', () => {
    const book = Book.open('100.00');
    const bet = book.submit(Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    const win = book.submit(Kind.Win, '30.00', { referenceExternalTransactionId: 'bet-1' });
    expect(win.tx.status).toBe(Status.Processed);
    expect(win.tx.referenceTransactionId).toBe(bet.tx.id);
    expect(book.balance()).toBe('120.00');
    book.assertConsistent();
  });

  test('referenciando algo que não é BET → INVALID_REFERENCE_KIND', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Win, '10.00', { externalTransactionId: 'win-1' });
    const { result } = book.submit(Kind.Win, '10.00', { referenceExternalTransactionId: 'win-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.InvalidReferenceKind });
    book.assertConsistent();
  });
});

describe('LOSS', () => {
  test('registra o resultado sem mover saldo e sem ledger', () => {
    const book = Book.open('100.00');
    const { tx, result } = book.submit(Kind.Loss, '0.00');
    expect(result).toEqual({ outcome: Status.Processed, ledgerEntry: undefined });
    expect(tx.status).toBe(Status.Processed);
    expect(book.balance()).toBe('100.00');
    expect(book.ledger).toHaveLength(1);
    expect(book.wallet.version).toBe(1);
    book.assertConsistent();
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED com 1 CREDIT', () => {
    const book = Book.open('100.00');
    const bet = book.submit(Kind.Bet, '25.00', { externalTransactionId: 'bet-1' });
    const refund = book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(refund.tx.status).toBe(Status.Processed);
    expect(refund.tx.referenceTransactionId).toBe(bet.tx.id);
    expect(book.balance()).toBe('100.00');
    expect(book.ledger.at(-1)?.direction).toBe(LedgerDirection.Credit);
    book.assertConsistent();
  });

  test('uma única vez: segundo REFUND → REFERENCE_ALREADY_REVERSED', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '25.00', { externalTransactionId: 'bet-1' });
    book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    const second = book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(second.result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(book.balance()).toBe('100.00');
    book.assertConsistent();
  });

  test('REFUND e depois ROLLBACK da mesma BET não creditam duas vezes', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '25.00', { externalTransactionId: 'bet-1' });
    book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    const rollback = book.submit(Kind.Rollback, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(rollback.result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(book.balance()).toBe('100.00');
    book.assertConsistent();
  });

  test('só referencia BET', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Win, '25.00', { externalTransactionId: 'win-1' });
    const { result } = book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'win-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });

  test('valor diferente da referência → REFERENCE_AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '25.00', { externalTransactionId: 'bet-1' });
    const { result } = book.submit(Kind.Refund, '20.00', { referenceExternalTransactionId: 'bet-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceAmountMismatch });
    book.assertConsistent();
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const book = Book.open('10.00');
    book.submit(Kind.Bet, '50.00', { externalTransactionId: 'bet-1' }); // rejeitada por saldo
    const { result } = book.submit(Kind.Refund, '50.00', { referenceExternalTransactionId: 'bet-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceNotProcessed });
    expect(book.balance()).toBe('10.00');
  });

  test.each([
    ['rodada', { roundId: 'other-round' }],
    ['player', { playerId: 'other-player' }],
    ['wallet', { walletId: 'other-wallet' }],
  ])('referência de outra %s → REFERENCE_MISMATCH', (_, betOverrides) => {
    const book = Book.open('100.00');
    // A BET "de outra wallet/player" é inserida diretamente no livro, como se viesse do repositório.
    const foreignBet = newTransaction(Kind.Bet, '25.00', { externalTransactionId: 'bet-1', ...betOverrides });
    foreignBet.markProcessed(undefined, NOW, brl('75.00'));
    book.transactions.push(foreignBet);
    const { result } = book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceMismatch });
    expect(book.balance()).toBe('100.00');
  });

  test('referência de outro provider não é encontrada → PENDING_REFERENCE', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '25.00', { externalTransactionId: 'bet-1', providerId: 'provider-b' });
    const { result } = book.submit(Kind.Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(result.outcome).toBe(Status.PendingReference);
  });
});

describe('ROLLBACK', () => {
  test('de BET credita o valor apostado', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    book.submit(Kind.Rollback, '40.00', { referenceExternalTransactionId: 'bet-1' });
    expect(book.balance()).toBe('100.00');
    expect(book.ledger.at(-1)?.direction).toBe(LedgerDirection.Credit);
    book.assertConsistent();
  });

  test('de WIN debita o valor ganho', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Win, '30.00', { externalTransactionId: 'win-1' });
    book.submit(Kind.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    expect(book.balance()).toBe('100.00');
    expect(book.ledger.at(-1)?.direction).toBe(LedgerDirection.Debit);
    book.assertConsistent();
  });

  test('de REFUND debita o valor reembolsado', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '20.00', { externalTransactionId: 'bet-1' });
    book.submit(Kind.Refund, '20.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' });
    const rollback = book.submit(Kind.Rollback, '20.00', { referenceExternalTransactionId: 'refund-1' });
    expect(rollback.tx.status).toBe(Status.Processed);
    expect(book.balance()).toBe('80.00');
    book.assertConsistent();
  });

  test('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const book = Book.open('0.00');
    book.submit(Kind.Win, '50.00', { externalTransactionId: 'win-1' });
    book.submit(Kind.Bet, '45.00');
    const { tx, result } = book.submit(Kind.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(tx.observedBalance?.toJSON().amount).toBe('5.00');
    expect(book.balance()).toBe('5.00');
    book.assertConsistent();
  });

  test('não pode ser revertido duas vezes', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-1' });
    const second = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(second.result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(book.balance()).toBe('100.00');
    book.assertConsistent();
  });

  test('não referencia LOSS nem ROLLBACK', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Loss, '0.00', { externalTransactionId: 'loss-1' });
    const { result } = book.submit(Kind.Rollback, '0.01', { referenceExternalTransactionId: 'loss-1' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });
});

describe('referência fora de ordem (§7.1, §7.8)', () => {
  test('ROLLBACK antes da BET → PENDING_REFERENCE; BET chega; reprocessamento aplica', () => {
    const book = Book.open('100.00');
    const rollback = book.submit(Kind.Rollback, '30.00', { referenceExternalTransactionId: 'bet-late' });
    expect(rollback.result.outcome).toBe(Status.PendingReference);
    expect(rollback.tx.status).toBe(Status.PendingReference);
    expect(rollback.tx.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
    expect(book.balance()).toBe('100.00');

    const bet = book.submit(Kind.Bet, '30.00', { externalTransactionId: 'bet-late' });
    expect(book.balance()).toBe('70.00');

    const retry = book.settle(rollback.tx, new Date(NOW.getTime() + 2_000));
    expect(retry.outcome).toBe(Status.Processed);
    expect(rollback.tx.referenceTransactionId).toBe(bet.tx.id);
    expect(book.balance()).toBe('100.00');
    book.assertConsistent();
  });

  test('referência ainda PENDING_REFERENCE é tratada como ausente', () => {
    const book = Book.open('100.00');
    book.submit(Kind.Refund, '10.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'missing' });
    const { result } = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'refund-1' });
    expect(result.outcome).toBe(Status.PendingReference);
  });

  test('tentativas esgotadas → REJECTED REFERENCE_NOT_FOUND', () => {
    const book = Book.open('100.00');
    const { tx } = book.submit(Kind.Refund, '10.00', { referenceExternalTransactionId: 'never' });
    expect(book.settle(tx).outcome).toBe(Status.PendingReference); // tentativa 1
    expect(book.settle(tx).outcome).toBe(Status.PendingReference); // tentativa 2
    expect(book.settle(tx)).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.ReferenceNotFound });
    expect(tx.status).toBe(Status.Rejected);
    expect(book.balance()).toBe('100.00');
    book.assertConsistent();
  });
});

describe('validações de pertencimento', () => {
  test('moeda da operação diferente da wallet → CURRENCY_MISMATCH', () => {
    const book = Book.open('100.00');
    const { tx, result } = book.submit(Kind.Bet, '10.00', { currency: 'USD' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(tx.observedBalance).toEqual(Money.from({ amount: '100.00', currency: 'BRL' }));
    expect(book.balance()).toBe('100.00');
  });

  test('player diferente do dono da wallet → WALLET_PLAYER_MISMATCH', () => {
    const book = Book.open('100.00');
    const { result } = book.submit(Kind.Bet, '10.00', { playerId: 'someone-else' });
    expect(result).toEqual({ outcome: Status.Rejected, failureCode: FailureCode.WalletPlayerMismatch });
  });

  test('transação de outra wallet ou já terminal é erro de programação', () => {
    const book = Book.open('100.00');
    expect(() => book.settle(newTransaction(Kind.Bet, '1.00', { walletId: 'other' }))).toThrow(InvalidTransactionStateError);
    const { tx } = book.submit(Kind.Bet, '1.00');
    expect(() => book.settle(tx)).toThrow(InvalidTransactionStateError);
  });
});

describe('sequência longa mantém o invariante saldo == ledger', () => {
  test('mistura de operações', () => {
    const book = Book.open('500.00');
    book.submit(Kind.Bet, '100.00', { externalTransactionId: 'b1' });
    book.submit(Kind.Win, '250.00', { externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });
    book.submit(Kind.Bet, '50.00', { externalTransactionId: 'b2' });
    book.submit(Kind.Loss, '0.00');
    book.submit(Kind.Refund, '50.00', { externalTransactionId: 'r2', referenceExternalTransactionId: 'b2' });
    book.submit(Kind.Rollback, '250.00', { referenceExternalTransactionId: 'w1' });
    book.submit(Kind.Bet, '10000.00'); // rejeitada
    expect(book.balance()).toBe('400.00');
    book.assertConsistent();
  });
});
