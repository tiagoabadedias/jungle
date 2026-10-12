import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { createSqsClient, QUEUE_URLS, type QueueUrls, resolveQueueUrl, SQS_CLIENT } from './sqs-client.ts';

class SqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createSqsClient(config.sqs) },
    {
      provide: QUEUE_URLS,
      inject: [SQS_CLIENT, APP_CONFIG],
      useFactory: async (client: SQSClient, config: AppConfig): Promise<QueueUrls> => ({
        wager: await resolveQueueUrl(client, config.sqs.wagerQueueName),
        wagerDlq: await resolveQueueUrl(client, config.sqs.wagerDlqName),
        events: await resolveQueueUrl(client, config.sqs.eventsQueueName),
      }),
    },
    SqsLifecycle,
  ],
  exports: [SQS_CLIENT, QUEUE_URLS],
})
export class SqsModule {}
