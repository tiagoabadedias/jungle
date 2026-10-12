import type { InboxMessage } from '../../domain/inbox-message.ts';

export interface InboxRepository {
  /**
   * `INSERT … ON CONFLICT DO NOTHING`. true quando a mensagem é nova nesta transação;
   * false quando já foi registrada (redelivery) — a linha só existe se o processamento comitou.
   */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}
