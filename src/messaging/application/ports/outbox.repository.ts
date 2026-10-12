import type { OutboxMessage } from '../../domain/outbox-message.ts';

export interface OutboxRepository {
  insert(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Reivindica mensagens pendentes e vencidas com `FOR UPDATE SKIP LOCKED`: publishers
   * concorrentes (outras instâncias) nunca pegam a mesma linha ao mesmo tempo.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persiste o resultado da tentativa (publicada ou reagendada). */
  saveDelivery(message: OutboxMessage): Promise<void>;
}
