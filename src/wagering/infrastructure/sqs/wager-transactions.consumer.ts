import { type Message, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { errorMessage } from '../../../shared/application/error-message.ts';
import type { ExponentialBackoff } from '../../../shared/domain/exponential-backoff.ts';
import { FAULT_AFTER_COMMIT_BEFORE_ACK } from '../../../shared/infrastructure/config/app-config.ts';
import { assignLogContext, runWithLogContext } from '../../../shared/infrastructure/observability/log-context.ts';
import { Metrics } from '../../../shared/infrastructure/observability/metrics.ts';
import type { WorkerLogger } from '../../../shared/infrastructure/workers/polling-worker.ts';
import type { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case.ts';
import { logWagerHandled, recordWagerFailure, recordWagerResult } from '../observability/wager-telemetry.ts';
import { toProcessCommand } from '../wager-submission.ts';
import { type MessageOutcome, receiveCountOf, SqsMessageSettler } from './sqs-message-settler.ts';
import { classifyError, errorCode } from './wager-error-classification.ts';
import { parseWagerMessage } from './wager-transaction-message.ts';

export type { MessageAction, MessageOutcome } from './sqs-message-settler.ts';

export interface WagerConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  maxAttempts: number;
  visibilityBackoff: ExponentialBackoff;
  drainTimeoutMs: number;
  faultInjection?: typeof FAULT_AFTER_COMMIT_BEFORE_ACK | undefined;
}

/**
 * Consumer de `wager-transactions.fifo` (§10). Reutiliza o mesmo use case do HTTP, com
 * deduplicação pela inbox persistente. O `DeleteMessage` (ack) só acontece depois do commit.
 */
export class WagerTransactionsConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private polling: AbortController | undefined;
  private readonly settler: SqsMessageSettler;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly options: WagerConsumerOptions,
    private readonly logger: WorkerLogger & { log(message: unknown): void; warn(message: unknown): void },
    private readonly metrics: Metrics = new Metrics(),
  ) {
    this.settler = new SqsMessageSettler(sqs, options, logger, metrics);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * SIGTERM (§10): para de buscar, cancela o long polling, conclui a mensagem em andamento e
   * devolve a visibilidade das ainda não iniciadas. Se o prazo de drenagem estourar, o
   * processo segue para o shutdown; a mensagem in-flight volta a ficar visível sozinha e a
   * inbox impede efeito duplicado na redelivery.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.polling?.abort();
    if (this.loop === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), this.options.drainTimeoutMs);
    });
    const outcome = await Promise.race([this.loop.then(() => 'DRAINED' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'TIMEOUT') this.logger.warn({ msg: 'consumer drain timed out', consumer: this.options.consumerName });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ msg: 'sqs receive failed', error: errorMessage(error) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /**
   * Um ciclo de long polling + processamento sequencial do lote, preservando a ordem de cada
   * grupo FIFO: se uma mensagem é reagendada, as seguintes do mesmo grupo no lote não são
   * processadas antes dela — ficam invisíveis pelo mesmo tempo e voltam depois, na ordem.
   * Mensagem enviada à DLQ não bloqueia o grupo (ela saiu da fila).
   */
  async pollOnce(waitTimeSeconds = this.options.waitTimeSeconds): Promise<MessageOutcome[]> {
    this.polling = new AbortController();
    let messages: Message[];
    try {
      const output = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.polling.signal },
      );
      messages = output.Messages ?? [];
    } catch (error) {
      if (this.polling.signal.aborted) return [];
      throw error;
    }

    const outcomes: MessageOutcome[] = [];
    /** Grupo → visibilidade (s) da mensagem reagendada que bloqueia o restante do grupo no lote. */
    const blockedGroups = new Map<string, number>();
    for (const [index, message] of messages.entries()) {
      // Parada solicitada (via stop(), que zera `running`): o restante do lote volta para a fila.
      if (this.loop !== undefined && !this.running) {
        for (const pending of messages.slice(index)) outcomes.push(await this.settler.release(pending));
        break;
      }
      const group = message.Attributes?.MessageGroupId;
      const blockedFor = group === undefined ? undefined : blockedGroups.get(group);
      if (blockedFor !== undefined) {
        outcomes.push(await this.settler.holdForGroupOrder(message, blockedFor));
        continue;
      }
      const outcome = await this.handleSafely(message);
      outcomes.push(outcome);
      if (outcome.action === 'RETRY_SCHEDULED' && group !== undefined) {
        blockedGroups.set(group, this.settler.retryVisibilitySeconds(receiveCountOf(message)));
      }
    }
    return outcomes;
  }

  /** Cada mensagem tem o próprio contexto de log: messageId (SQS) e, depois do parse, os ids do payload. */
  private async handleSafely(message: Message): Promise<MessageOutcome> {
    return runWithLogContext({ correlationId: message.MessageId, messageId: message.MessageId }, () =>
      this.handleWithContext(message),
    );
  }

  /**
   * Uma falha do SQS ao confirmar/reagendar uma mensagem não pode abortar o resto do lote.
   * A mensagem afetada volta a ficar visível no fim do visibility timeout; a inbox impede
   * efeito duplicado na redelivery.
   */
  private async handleWithContext(message: Message): Promise<MessageOutcome> {
    try {
      return await this.handle(message);
    } catch (error) {
      this.logger.error({
        msg: 'sqs operation failed while handling message',
        sqsMessageId: message.MessageId,
        error: errorMessage(error),
      });
      return { sqsMessageId: message.MessageId ?? 'unknown', action: 'RETRY_SCHEDULED', detail: 'SQS_OPERATION_FAILED' };
    }
  }

  private async handle(message: Message): Promise<MessageOutcome> {
    const receiveCount = receiveCountOf(message);

    let status: string;
    const elapsed = Metrics.startTimer();
    try {
      const envelope = parseWagerMessage(message.Body);
      const { data } = envelope;
      assignLogContext({
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        providerId: data.providerId,
        walletId: data.walletId,
      });
      const result = await this.processTransaction.execute(
        toProcessCommand(
          data,
          data.idempotencyKey,
          { correlationId: envelope.messageId, causationId: envelope.messageId },
          { consumerName: this.options.consumerName, messageId: envelope.messageId },
        ),
      );
      recordWagerResult(this.metrics, 'sqs', data.kind, result, elapsed());
      logWagerHandled(this.logger, data.kind, result);
      status = result.status;
    } catch (error) {
      recordWagerFailure(this.metrics, 'sqs', error, elapsed());
      const code = errorCode(error);
      if (classifyError(error) === 'PERMANENT') return this.settler.deadLetter(message, code);
      if (receiveCount >= this.options.maxAttempts) return this.settler.deadLetter(message, `MAX_ATTEMPTS_EXCEEDED:${code}`);
      return this.settler.retryLater(message, receiveCount, code);
    }

    if (this.options.faultInjection === FAULT_AFTER_COMMIT_BEFORE_ACK) {
      // Simula queda do processo entre o commit e o ack (§13 conc. 5). Só em testes.
      process.kill(process.pid, 'SIGKILL');
    }
    const outcome = await this.settler.ack(message, status);
    this.logger.log({ msg: 'message processed', status, receiveCount });
    return outcome;
  }
}
