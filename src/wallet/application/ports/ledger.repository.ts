import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Posição do último item devolvido; undefined quando não há próxima página. */
  next: LedgerCursor | undefined;
}

export interface LedgerTotals {
  /** Σ créditos − Σ débitos, em unidades menores. */
  balanceMinor: bigint;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Página ordenada por (createdAt, id), estritamente após o cursor. */
  page(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<LedgerPage>;
  totals(walletId: string): Promise<LedgerTotals>;
}
