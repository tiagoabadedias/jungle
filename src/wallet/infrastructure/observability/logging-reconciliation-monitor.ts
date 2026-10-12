import { Inject, Injectable, Logger } from '@nestjs/common';
import { METRICS, type Metrics } from '../../../shared/infrastructure/observability/metrics.ts';
import type { ReconciliationMonitor, ReconciliationReport } from '../../application/ports/reconciliation-monitor.ts';

/** Divergência de reconciliação: logada como erro e contabilizada em métrica, nunca corrigida (§9). */
@Injectable()
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  private readonly logger = new Logger('Reconciliation');

  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  mismatch(report: ReconciliationReport): void {
    this.metrics.reconciliationMismatches.inc();
    this.logger.error({
      msg: 'wallet balance diverges from ledger',
      walletId: report.walletId,
      checkedEntries: report.checkedEntries,
    });
  }
}
