import type { EventContext } from '../domain/integration-event.ts';
import type { IdGenerator } from './ports/id-generator.ts';

/** Contexto de rastreio de quem originou a operação (requisição HTTP ou mensagem SQS). */
export interface RequestContext {
  correlationId: string;
  /** id da mensagem/requisição que causou a operação */
  causationId?: string | undefined;
}

export function eventContext(ids: IdGenerator, at: Date, request: RequestContext): EventContext {
  return {
    eventId: ids.next(),
    correlationId: request.correlationId,
    causationId: request.causationId,
    occurredAt: at,
  };
}

