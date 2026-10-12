import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
} from '../../../src/shared/domain/domain-error.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { brl, ledgerBalance, NOW, nextId, openWallet, PLAYER_ID, WALLET_ID } from '../fixtures.ts';

const later = new Date(NOW.getTime() + 1_000);
const movement = (amount: string) => ({ money: brl(amount), transactionId: nextId('tx'), entryId: nextId('entry'), at: later });

describe('Wallet.open', () => {
  test('saldo zero: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('0.00'), at: NOW });
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('não compartilha o Date de quem chamou', () => {
    const at = new Date(NOW.getTime());
    const { wallet } = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('0.00'), at });
    at.setTime(0);
    expect(wallet.createdAt).toEqual(NOW);
  });

  test('saldo positivo: crédito de abertura no ledger e version continua 1', () => {
    const { wallet, ledger } = openWallet('1000.00');
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.direction).toBe(LedgerDirection.Credit);
    expect(ledger[0]?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(ledger[0]?.balanceAfter.toJSON().amount).toBe('1000.00');
    expect(wallet.balance.equals(ledgerBalance(ledger))).toBe(true);
  });

  test('saldo positivo exige ids da transação OPENING e do lançamento', () => {
    expect(() => Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('10.00'), at: NOW })).toThrow(
      InvariantViolationError,
    );
  });

  test('saldo inicial negativo é rejeitado', () => {
    expect(() =>
      Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: Money.fromMinorUnits(-1n, 'BRL'), at: NOW }),
    ).toThrow(InvariantViolationError);
  });

  test('a moeda da wallet é a moeda do saldo inicial', () => {
    expect(openWallet('5.00', { currency: 'USD' }).wallet.currency).toBe('USD');
  });
});

describe('Wallet.debit / credit', () => {
  test('débito gera lançamento DEBIT, altera saldo e incrementa version', () => {
    const { wallet, ledger } = openWallet('100.00');
    const entry = wallet.debit(movement('25.00'));
    ledger.push(entry);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(wallet.balance.equals(ledgerBalance(ledger))).toBe(true);
  });

  test('crédito gera lançamento CREDIT e incrementa version', () => {
    const { wallet, ledger } = openWallet('100.00');
    ledger.push(wallet.credit(movement('0.01')));
    expect(wallet.balance.toJSON().amount).toBe('100.01');
    expect(wallet.version).toBe(2);
    expect(wallet.balance.equals(ledgerBalance(ledger))).toBe(true);
  });

  test('débito que deixaria saldo negativo lança erro e não altera estado', () => {
    const { wallet } = openWallet('100.00');
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito de todo o saldo é permitido (saldo zero não é negativo)', () => {
    const { wallet } = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    wallet.debit(movement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('moeda diferente da wallet lança CurrencyMismatchError', () => {
    const { wallet } = openWallet('100.00');
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd.money)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimento zero ou negativo é rejeitado (não haveria alteração de saldo)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvariantViolationError);
    expect(() => wallet.debit({ ...movement('1.00'), money: Money.fromMinorUnits(-100n, 'BRL') })).toThrow(
      InvariantViolationError,
    );
    expect(wallet.version).toBe(1);
  });

  test('version só incrementa quando o saldo muda', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(movement('10.00'));
    wallet.credit(movement('5.00'));
    expect(wallet.version).toBe(3);
    expect(() => wallet.debit(movement('1000.00'))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(3);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: later,
    });
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(NOW);
    expect(wallet.updatedAt).toEqual(later);
  });
});
