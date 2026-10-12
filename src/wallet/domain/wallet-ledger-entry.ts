import { InvariantViolationError } from '../../shared/domain/domain-error.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from './ledger-direction.ts';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento do ledger. Imutável por estrutura (§6.4): todos os campos são readonly,
 * não há métodos de transição e a instância é congelada. `create` valida a aritmética.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('ledger entry amount must be positive');
    }
    if (!props.money.hasSameCurrencyAs(props.balanceBefore) || !props.money.hasSameCurrencyAs(props.balanceAfter)) {
      throw new InvariantViolationError('ledger entry amounts must share the same currency');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry balances must not be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('ledger entry is not balanced: balanceBefore ± money must equal balanceAfter');
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida (§6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    if (!this.money.hasSameCurrencyAs(this.balanceBefore) || !this.money.hasSameCurrencyAs(this.balanceAfter)) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
