import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { PublishOutboxUseCase } from '../../src/messaging/application/publish-outbox.use-case.ts';
import { SqsEventPublisher } from '../../src/messaging/infrastructure/sqs/sqs-event-publisher.ts';
import { ExponentialBackoff } from '../../src/shared/domain/exponential-backoff.ts';
import type { Clock } from '../../src/shared/application/ports/clock.ts';
import { ENTITY_SCHEMAS } from '../../src/shared/infrastructure/database/entities.ts';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work.ts';
import { requireEnv } from '../../src/shared/infrastructure/config/app-config.ts';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs-client.ts';
import { UuidV7Generator } from '../../src/shared/infrastructure/system-providers.ts';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.ts';
import { ReprocessPendingReferencesUseCase } from '../../src/wagering/application/reprocess-pending-references.use-case.ts';
import {
  type WagerConsumerOptions,
  WagerTransactionsConsumer,
} from '../../src/wagering/infrastructure/sqs/wager-transactions.consumer.ts';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.ts';
import { assertLedgerInvariant, connectApp, connectOwner, migrateUp } from './database.ts';
import { wager } from './http-client.ts';

/** Relógio controlável: permite "adiantar o tempo" para vencer backoffs sem dormir. */
export class MutableClock implements Clock {
  constructor(private current: Date = new Date()) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TestQueues {
  wager: string;
  dlq: string;
  events: string;
  /** Nomes (processos filhos resolvem as URLs via SQS_WAGER_QUEUE/DLQ/EVENTS). */
  names: { wager: string; dlq: string; events: string };
  delete(): Promise<void>;
}

/** Filas FIFO exclusivas do teste (nomes aleatórios), com a mesma RedrivePolicy da fila real. */
export async function createTestQueues(
  sqs: SQSClient,
  maxReceiveCount = 5,
  visibilityTimeoutSeconds = 30,
): Promise<TestQueues> {
  const suffix = randomUUID().slice(0, 8);
  const names = { wager: `test-wager-${suffix}.fifo`, dlq: `test-wager-dlq-${suffix}.fifo`, events: `test-events-${suffix}.fifo` };
  const create = async (name: string, attributes: Record<string, string>) =>
    (await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }))).QueueUrl ?? '';
  const dlq = await create(names.dlq, {});
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes?.['QueueArn'];
  const wager = await create(names.wager, {
    VisibilityTimeout: String(visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
  });
  const events = await create(names.events, {});
  return {
    names,
    wager,
    dlq,
    events,
    delete: async () => {
      for (const url of [wager, dlq, events]) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    },
  };
}

export interface WagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function wagerEnvelope(data: Record<string, unknown>, messageId = `msg-${randomUUID()}`): WagerEnvelope {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

/** Envia para a fila FIFO. `dedupId` aleatório por padrão: simula reenvio pelo produtor. */
export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, groupId: string, dedupId: string = randomUUID()) {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }));
}

/**
 * Consome (lê e apaga) tudo o que estiver visível na fila. Em FIFO, mensagens recebidas e não
 * apagadas bloqueiam as seguintes do mesmo grupo — por isso o helper apaga o que lê.
 */
export async function drainVisible(sqs: SQSClient, queueUrl: string, rounds = 3): Promise<Message[]> {
  const collected: Message[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const output = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    const batch = output.Messages ?? [];
    collected.push(...batch);
    for (const message of batch) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    if (batch.length === 0 && round > 0) break;
  }
  return collected;
}

/** Grafo da aplicação montado à mão (sem NestJS) sobre PostgreSQL e MiniStack reais. */
/** Cliente SQS dos testes: MiniStack do `.env.test` (endpoint e região). */
export function testSqsClient(): SQSClient {
  return createSqsClient({ endpoint: requireEnv('SQS_ENDPOINT'), region: requireEnv('AWS_REGION') });
}

export class MessagingHarness {
  readonly ids = new UuidV7Generator();
  readonly referenceRetry = { maxAttempts: 3, backoff: ExponentialBackoff.create({ baseDelayMs: 2_000, maxDelayMs: 60_000 }) };

  private readonly walletIds: string[] = [];

  private constructor(
    readonly orm: MikroORM,
    readonly sqs: SQSClient,
    readonly queues: TestQueues,
    readonly clock: Clock,
  ) {}

  static async start(options: { clock?: Clock; maxReceiveCount?: number } = {}): Promise<MessagingHarness> {
    const owner = await connectOwner();
    await migrateUp(owner);
    await owner.close(true);
    const orm = await connectApp({ entities: ENTITY_SCHEMAS, poolMax: 8 });
    const sqs = testSqsClient();
    const queues = await createTestQueues(sqs, options.maxReceiveCount);
    return new MessagingHarness(orm, sqs, queues, options.clock ?? { now: () => new Date() });
  }

  async stop(): Promise<void> {
    await this.queues.delete();
    this.sqs.destroy();
    await this.orm.close(true);
  }

  unitOfWork(lockTimeoutMs = 5_000): MikroOrmUnitOfWork {
    return new MikroOrmUnitOfWork(this.orm, { lockTimeoutMs });
  }

  processUseCase(lockTimeoutMs = 5_000): ProcessWagerTransactionUseCase {
    return new ProcessWagerTransactionUseCase(this.unitOfWork(lockTimeoutMs), this.clock, this.ids, this.referenceRetry);
  }

  publishUseCase(eventsQueueUrl = this.queues.events, batchSize = 20): PublishOutboxUseCase {
    return new PublishOutboxUseCase(this.unitOfWork(), new SqsEventPublisher(this.sqs, eventsQueueUrl), this.clock, {
      batchSize,
      backoff: ExponentialBackoff.create({ baseDelayMs: 1_000, maxDelayMs: 60_000 }),
    });
  }

  reprocessUseCase(): ReprocessPendingReferencesUseCase {
    return new ReprocessPendingReferencesUseCase(this.unitOfWork(), this.clock, this.ids, this.referenceRetry, 100);
  }

  consumer(overrides: Partial<WagerConsumerOptions> & { lockTimeoutMs?: number } = {}): WagerTransactionsConsumer {
    const { lockTimeoutMs, ...options } = overrides;
    return new WagerTransactionsConsumer(
      this.sqs,
      this.processUseCase(lockTimeoutMs),
      {
        queueUrl: this.queues.wager,
        dlqUrl: this.queues.dlq,
        consumerName: 'wager-transactions-consumer',
        waitTimeSeconds: 1,
        maxMessages: 10,
        maxAttempts: 5,
        visibilityBackoff: ExponentialBackoff.create({ baseDelayMs: 1_000, maxDelayMs: 5_000 }),
        drainTimeoutMs: 10_000,
        ...options,
      },
      new Logger('TestConsumer'),
    );
  }

  async createWallet(amount: string) {
    const playerId = randomUUID();
    const view = await new CreateWalletUseCase(this.unitOfWork(), this.clock, this.ids).execute({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
      context: { correlationId: 'test' },
    });
    this.walletIds.push(view.id);
    return { walletId: view.id, playerId };
  }

  /** Invariante final (§13) das wallets criadas desde a última verificação (chamado no `afterEach`). */
  async assertLedgerInvariant(): Promise<void> {
    const walletIds = this.walletIds.splice(0);
    await assertLedgerInvariant(this.orm, walletIds);
  }

  /** Payload `data` de uma mensagem de aposta. */
  wagerData(wallet: { walletId: string; playerId: string }, kind: string, amount: string, overrides: Record<string, unknown> = {}) {
    const base = wager(wallet, kind, amount);
    // A key é derivada do id gerado; overrides (inclusive inválidos, para testar a DLQ) vêm por último.
    return { ...base, idempotencyKey: `${base.providerId}:${base.externalTransactionId}`, ...overrides };
  }

  async send(envelope: WagerEnvelope | string, groupId: string, dedupId: string = randomUUID()): Promise<void> {
    const body = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
    await sendRaw(this.sqs, this.queues.wager, body, groupId, dedupId);
  }
}
