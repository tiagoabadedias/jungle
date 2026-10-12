import { InvalidTransactionStateError } from '../../shared/domain/domain-error.ts';
import type { ExponentialBackoff } from '../../shared/domain/exponential-backoff.ts';
import type { IntegrationEvent } from '../../shared/domain/integration-event.ts';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

/**
 * Evento de integração aguardando publicação (§6.5, §11). Gravado na mesma transação SQL
 * da alteração financeira; publicado depois do commit por um worker.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** O id da mensagem é o eventId: publicações duplicadas são identificáveis pelo consumidor. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze(JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>);
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt === undefined ? undefined : new Date(state.nextAttemptAt.getTime()),
      state.publishedAt === undefined ? undefined : new Date(state.publishedAt.getTime()),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt === undefined ? undefined : new Date(this._nextAttemptAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : new Date(this._publishedAt.getTime());
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} is already published`);
    }
    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date, backoff: ExponentialBackoff): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} is already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(now, this._attempts - 1);
  }
}
