import { WalletNotFoundError } from '../../shared/application/application-error.ts';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import { Money } from '../../shared/domain/money.ts';
import type { ReconciliationMonitor, ReconciliationReport } from './ports/reconciliation-monitor.ts';

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger. Usa lock compartilhado
 * na wallet: nenhuma movimentação acontece entre a leitura do saldo e a soma dos lançamentos.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.lockForShare(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(walletId);
      const totals = await ledger.totals(walletId);
      const calculated = Money.fromMinorUnits(totals.balanceMinor, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.entries,
      };
    });
    if (!report.consistent) this.monitor.mismatch(report);
    return report;
  }
}
