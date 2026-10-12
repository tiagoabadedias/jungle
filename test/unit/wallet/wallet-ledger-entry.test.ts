import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction.ts';
import { type LedgerEntryState, WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry.ts';
import { brl, NOW, WALLET_ID } from '../fixtures.ts';

const valid = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: 'entry-1',
  walletId: WALLET_ID,
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: NOW,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('aceita lançamento balanceado (débito e crédito)', () => {
    expect(WalletLedgerEntry.create(valid()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      valid({ direction: LedgerDirection.Credit, balanceBefore: brl('75.00'), balanceAfter: brl('100.00') }),
    );
    expect(credit.isBalanced()).toBe(true);
  });

  test('rejeita aritmética inconsistente', () => {
    expect(() => WalletLedgerEntry.create(valid({ balanceAfter: brl('75.01') }))).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create(valid({ direction: LedgerDirection.Credit }))).toThrow(InvariantViolationError);
  });

  test('rejeita valor zero ou negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(valid({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita saldo negativo antes ou depois', () => {
    expect(() =>
      WalletLedgerEntry.create(
        valid({ balanceBefore: brl('10.00'), balanceAfter: Money.fromMinorUnits(-1500n, 'BRL') }),
      ),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita moedas diferentes', () => {
    const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
    expect(() => WalletLedgerEntry.create(valid({ balanceBefore: usd('100.00'), balanceAfter: usd('75.00') }))).toThrow(
      InvariantViolationError,
    );
  });
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  test('instância congelada: atribuição falha em strict mode', () => {
    const entry = WalletLedgerEntry.create(valid());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0.00');
    }).toThrow(TypeError);
  });

  test('rehydrate não revalida (estado já persistido)', () => {
    const entry = WalletLedgerEntry.rehydrate(valid({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
