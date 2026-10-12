import type { MoneyProps } from '../../../shared/domain/money.ts';

/** Resultado da reconciliação (§9): saldo armazenado × reconstruído pelo ledger. */
export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Destino das divergências: log estruturado e métrica (§9). Nunca corrige o saldo. */
export interface ReconciliationMonitor {
  mismatch(report: ReconciliationReport): void;
}

export const RECONCILIATION_MONITOR = Symbol('ReconciliationMonitor');
