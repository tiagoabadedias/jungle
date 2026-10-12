import { Inject, Logger, Module } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared/application/ports/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared/application/ports/clock.ts';
import { ID_GENERATOR, type IdGenerator } from '../shared/application/ports/id-generator.ts';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config/app-config.ts';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../shared/infrastructure/sqs/sqs-client.ts';
import { METRICS, type Metrics } from '../shared/infrastructure/observability/metrics.ts';
import { BackgroundWorkersLifecycle } from '../shared/infrastructure/workers/background-workers-lifecycle.ts';
import type { PollingWorker } from '../shared/infrastructure/workers/polling-worker.ts';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.ts';
import { ReprocessPendingReferencesUseCase } from './application/reprocess-pending-references.use-case.ts';
import { GetWagerTransactionUseCase } from './application/wager-transaction-views.ts';
import { ProviderTransactionsController, WageringController } from './infrastructure/http/wagering.controller.ts';
import { WagerTransactionsConsumer } from './infrastructure/sqs/wager-transactions.consumer.ts';
import { createPendingReferenceWorker } from './infrastructure/workers/pending-reference-worker.ts';

const PENDING_REFERENCE_WORKER = Symbol('PendingReferenceWorker');

/** Consumer SQS e worker de referências: iniciam no bootstrap e drenam antes do pool fechar. */
class WageringWorkersLifecycle extends BackgroundWorkersLifecycle {
  constructor(
    @Inject(WagerTransactionsConsumer) consumer: WagerTransactionsConsumer,
    @Inject(PENDING_REFERENCE_WORKER) pendingReferences: PollingWorker,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    super([
      { enabled: config.consumer.enabled, worker: consumer },
      { enabled: config.pendingReferences.enabled, worker: pendingReferences },
    ]);
  }
}

@Module({
  controllers: [WageringController, ProviderTransactionsController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new ProcessWagerTransactionUseCase(uow, clock, ids, config.referenceRetry),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow),
    },
    {
      provide: ReprocessPendingReferencesUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new ReprocessPendingReferencesUseCase(uow, clock, ids, config.referenceRetry, config.pendingReferences.batchSize),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [ReprocessPendingReferencesUseCase, APP_CONFIG, METRICS],
      useFactory: (useCase: ReprocessPendingReferencesUseCase, config: AppConfig, metrics: Metrics) =>
        createPendingReferenceWorker(useCase, config.pendingReferences.pollIntervalMs, metrics),
    },
    {
      provide: WagerTransactionsConsumer,
      inject: [SQS_CLIENT, QUEUE_URLS, ProcessWagerTransactionUseCase, APP_CONFIG, METRICS],
      useFactory: (
        client: SQSClient,
        queues: QueueUrls,
        useCase: ProcessWagerTransactionUseCase,
        config: AppConfig,
        metrics: Metrics,
      ) =>
        new WagerTransactionsConsumer(
          client,
          useCase,
          {
            queueUrl: queues.wager,
            dlqUrl: queues.wagerDlq,
            consumerName: config.consumer.consumerName,
            waitTimeSeconds: config.consumer.waitTimeSeconds,
            maxMessages: config.consumer.maxMessages,
            maxAttempts: config.consumer.maxAttempts,
            visibilityBackoff: config.consumer.visibilityBackoff,
            drainTimeoutMs: config.consumer.drainTimeoutMs,
            faultInjection: config.consumer.faultInjection,
          },
          new Logger('WagerTransactionsConsumer'),
          metrics,
        ),
    },
    WageringWorkersLifecycle,
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
