import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/app-config.ts';

/**
 * Cliente SQS (AWS SDK v3). Credenciais pela cadeia padrão do SDK (variáveis de ambiente).
 * O timeout de requisição precisa ser maior que o long polling (WaitTimeSeconds até 20 s).
 */
export function createSqsClient(config: Pick<SqsConfig, 'endpoint' | 'region'>): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
  });
}

export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (QueueUrl === undefined) throw new Error(`queue ${queueName} not found`);
  return QueueUrl;
}

export interface QueueUrls {
  wager: string;
  wagerDlq: string;
  events: string;
}

export const SQS_CLIENT = Symbol('SQSClient');
export const QUEUE_URLS = Symbol('QueueUrls');
