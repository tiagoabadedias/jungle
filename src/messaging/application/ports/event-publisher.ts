import type { OutboxMessage } from '../../domain/outbox-message.ts';

export interface PublishResult {
  /** ids das mensagens aceitas pelo broker */
  published: ReadonlySet<string>;
  /** ids que falharam, com o motivo (para log) */
  failed: ReadonlyMap<string, string>;
}

/** Publica eventos de integração no broker. Implementação: SQS (`wallet-events.fifo`). */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
