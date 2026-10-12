import { WalletNotFoundError } from '../../shared/application/application-error.ts';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import type { MoneyProps } from '../../shared/domain/money.ts';
import type { LedgerDirection } from '../domain/ledger-direction.ts';
import type { LedgerCursor } from './ports/ledger.repository.ts';
import { toWalletView, type WalletView } from './create-wallet.use-case.ts';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run(({ wallets }) => wallets.findById(walletId));
    if (wallet === undefined) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  next: LedgerCursor | undefined;
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;

export class ListLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<LedgerPageView> {
    return this.uow.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(walletId);
      const page = await ledger.page(walletId, after, limit);
      return {
        walletId,
        entries: page.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        next: page.next,
      };
    });
  }
}
