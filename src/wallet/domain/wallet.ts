import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../shared/domain/domain-error.ts';
import { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from './ledger-direction.ts';
import { WalletLedgerEntry } from './wallet-ledger-entry.ts';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transação interna OPENING; obrigatório quando o saldo inicial é positivo. */
  openingTransactionId?: string | undefined;
  openingEntryId?: string | undefined;
  at: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  /** Presente somente quando o saldo inicial é maior que zero (§9). */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate Root (§6.2). Única forma de alterar saldo é `debit`/`credit`, que devolvem
 * o lançamento correspondente: saldo e ledger nascem juntos. `version` começa em 1 e
 * incrementa somente quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance must not be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, new Date(props.at.getTime()), new Date(props.at.getTime()));
    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (props.openingTransactionId === undefined || props.openingEntryId === undefined) {
      throw new InvariantViolationError('a positive initial balance requires an OPENING transaction and ledger entry');
    }
    // O crédito de abertura faz parte da criação: version permanece 1 (§6.2).
    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      { money: props.initialBalance, transactionId: props.openingTransactionId, entryId: props.openingEntryId, at: props.at },
      false,
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições (§6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement, true);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement, true);
  }

  move(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    return this.apply(direction, movement, true);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement, bumpVersion: boolean): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvariantViolationError('wallet movements must have a positive amount');
    }
    if (direction === LedgerDirection.Debit && this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(movement.money) : balanceBefore.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    if (bumpVersion) this._version += 1;
    this._updatedAt = new Date(movement.at.getTime());
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
