export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. Só existe em memória dentro da transação SQL. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (§7.8). */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = Object.freeze([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
