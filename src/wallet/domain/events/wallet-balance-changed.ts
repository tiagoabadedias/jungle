import { InvariantViolationError } from '../../../shared/domain/domain-error.ts';
import { type EventContext, IntegrationEvent } from '../../../shared/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared/domain/money.ts';
import type { LedgerDirection } from '../ledger-direction.ts';
import type { Wallet } from '../wallet.ts';
import type { WalletLedgerEntry } from '../wallet-ledger-entry.ts';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitido somente quando o saldo muda (§11). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError(`ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
