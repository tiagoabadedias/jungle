import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import type { ExponentialBackoff } from '../../shared/domain/exponential-backoff.ts';
import type { Clock } from '../../shared/application/ports/clock.ts';
import type { EventPublisher } from './ports/event-publisher.ts';
import { errorMessage } from '../../shared/application/error-message.ts';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface PublishOutboxOptions {
  batchSize: number;
  backoff: ExponentialBackoff;
}

/**
 * Publica eventos depois do commit da transação financeira (§5.4, §11). Cada lote é
 * reivindicado com `FOR UPDATE SKIP LOCKED`, publicado e marcado na mesma transação:
 *  - várias instâncias publicam em paralelo sem pegar a mesma linha;
 *  - se o processo morrer antes do commit, o lock é liberado e outra instância republica
 *    (at-least-once; duplicatas são identificáveis pelo `eventId`).
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {}

  async publishBatch(): Promise<PublishOutboxResult> {
    return this.uow.run(async ({ outbox }) => {
      const due = await outbox.claimDue(this.clock.now(), this.options.batchSize);
      if (due.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const result = await this.publisher.publish(due).catch(
        (error: unknown): Awaited<ReturnType<EventPublisher['publish']>> => ({
          published: new Set<string>(),
          failed: new Map(due.map((message) => [message.id, errorMessage(error)])),
        }),
      );

      const now = this.clock.now();
      let published = 0;
      for (const message of due) {
        if (result.published.has(message.id)) {
          message.markPublished(now);
          published += 1;
        } else {
          message.scheduleRetry(now, this.options.backoff);
        }
        await outbox.saveDelivery(message);
      }
      return { claimed: due.length, published, failed: due.length - published };
    });
  }
}
