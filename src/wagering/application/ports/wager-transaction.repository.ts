import type { WagerTransaction } from '../../domain/wager-transaction.ts';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** ids de transações PENDING_REFERENCE cujo próximo reprocessamento já venceu. */
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  /** Persiste a mudança de estado de uma transação ainda não terminal no banco. */
  saveState(transaction: WagerTransaction, at: Date): Promise<void>;
}
