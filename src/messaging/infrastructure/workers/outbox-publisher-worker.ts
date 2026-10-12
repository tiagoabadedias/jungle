import { Logger } from '@nestjs/common';
import type { Metrics } from '../../../shared/infrastructure/observability/metrics.ts';
import { PollingWorker } from '../../../shared/infrastructure/workers/polling-worker.ts';
import type { PublishOutboxUseCase } from '../../application/publish-outbox.use-case.ts';

/** Publisher da outbox (§11): um tick = um lote reivindicado com `SKIP LOCKED`. */
export function createOutboxPublisherWorker(useCase: PublishOutboxUseCase, pollIntervalMs: number, metrics: Metrics): PollingWorker {
  const logger = new Logger('OutboxPublisher');
  return new PollingWorker(
    'outbox-publisher',
    pollIntervalMs,
    async () => {
      const result = await useCase.publishBatch();
      metrics.outboxPublished.inc(result.published);
      if (result.failed > 0) {
        metrics.retries.inc({ component: 'outbox_publisher', reason: 'PUBLISH_FAILED' }, result.failed);
        logger.warn({ msg: 'outbox events rescheduled', failed: result.failed });
      }
      // Só a parte publicada conta como progresso: falhas reagendadas não fazem o loop girar em vão.
      return result.published;
    },
    logger,
  );
}
