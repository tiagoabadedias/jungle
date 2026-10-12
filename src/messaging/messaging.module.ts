import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared/application/ports/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared/application/ports/clock.ts';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config/app-config.ts';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../shared/infrastructure/sqs/sqs-client.ts';
import { METRICS, type Metrics } from '../shared/infrastructure/observability/metrics.ts';
import { BackgroundWorkersLifecycle } from '../shared/infrastructure/workers/background-workers-lifecycle.ts';
import type { PollingWorker } from '../shared/infrastructure/workers/polling-worker.ts';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher.ts';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case.ts';
import { SqlOutboxBacklogProbe } from './infrastructure/persistence/outbox-backlog.ts';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher.ts';
import { createOutboxPublisherWorker } from './infrastructure/workers/outbox-publisher-worker.ts';

const OUTBOX_WORKER = Symbol('OutboxPublisherWorker');

/** Inicia o publisher no bootstrap; no shutdown espera o lote em andamento (antes do pool fechar). */
class OutboxPublisherLifecycle extends BackgroundWorkersLifecycle {
  constructor(@Inject(OUTBOX_WORKER) worker: PollingWorker, @Inject(APP_CONFIG) config: AppConfig) {
    super([{ enabled: config.outboxPublisher.enabled, worker }]);
  }
}

/** Liga a métrica de outbox lag (§12) à consulta da outbox, que pertence a este contexto. */
class OutboxBacklogMetric implements OnModuleInit {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  onModuleInit(): void {
    this.metrics.useOutboxBacklogProbe(new SqlOutboxBacklogProbe(this.orm));
  }
}

@Module({
  providers: [
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (client: SQSClient, queues: QueueUrls) => new SqsEventPublisher(client, queues.events),
    },
    {
      provide: PublishOutboxUseCase,
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, config: AppConfig) =>
        new PublishOutboxUseCase(uow, publisher, clock, {
          batchSize: config.outboxPublisher.batchSize,
          backoff: config.outboxPublisher.backoff,
        }),
    },
    {
      provide: OUTBOX_WORKER,
      inject: [PublishOutboxUseCase, APP_CONFIG, METRICS],
      useFactory: (useCase: PublishOutboxUseCase, config: AppConfig, metrics: Metrics) =>
        createOutboxPublisherWorker(useCase, config.outboxPublisher.pollIntervalMs, metrics),
    },
    OutboxPublisherLifecycle,
    OutboxBacklogMetric,
  ],
  exports: [PublishOutboxUseCase],
})
export class MessagingModule {}
