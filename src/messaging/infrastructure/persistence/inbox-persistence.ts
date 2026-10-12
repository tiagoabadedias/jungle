import { EntitySchema } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../application/ports/inbox.repository.ts';
import { InboxMessage } from '../../domain/inbox-message.ts';

/** Linha da tabela `inbox_messages`, chave (consumer_name, message_id). */
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'character', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', fieldName: 'received_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
  },
});

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    // Se outra transação estiver gravando o mesmo messageId, o INSERT espera o desfecho dela:
    // commit → conflito (redelivery); rollback → a linha é nossa.
    const result = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: null,
      })
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, { disableIdentityMap: true });
    if (record === null) return undefined;
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
