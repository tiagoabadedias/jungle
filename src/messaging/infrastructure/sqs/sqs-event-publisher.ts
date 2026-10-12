import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/event-publisher.ts';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import { errorMessage } from '../../../shared/application/error-message.ts';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica no `wallet-events.fifo`. `MessageGroupId` = aggregateId (wallet): o broker entrega
 * cada grupo na ordem de publicação, mas publishers concorrentes podem publicar fora da ordem
 * de ocorrência (ARCHITECTURE §9; `walletVersion` permite reordenar). `MessageDeduplicationId` = eventId: republicações na
 * janela de 5 min são descartadas pelo SQS — otimização; a garantia é o eventId no consumidor.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const published = new Set<string>();
    const failed = new Map<string, string>();
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const output = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((message) => ({
              Id: message.id,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
            })),
          }),
        );
        // SendMessageBatch pode falhar parcialmente sem lançar exceção.
        for (const entry of output.Successful ?? []) if (entry.Id !== undefined) published.add(entry.Id);
        for (const entry of output.Failed ?? []) {
          if (entry.Id !== undefined) failed.set(entry.Id, `${entry.Code ?? 'unknown'}: ${entry.Message ?? ''}`);
        }
      } catch (error) {
        for (const message of chunk) failed.set(message.id, errorMessage(error));
      }
    }
    return { published, failed };
  }
}
