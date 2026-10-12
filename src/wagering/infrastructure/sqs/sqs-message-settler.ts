import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { errorMessage } from '../../../shared/application/error-message.ts';
import type { ExponentialBackoff } from '../../../shared/domain/exponential-backoff.ts';
import { parsePositiveInteger } from '../../../shared/infrastructure/config/app-config.ts';
import type { Metrics } from '../../../shared/infrastructure/observability/metrics.ts';

export type MessageAction = 'ACKED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED' | 'RELEASED' | 'HELD_FOR_GROUP_ORDER';

export interface MessageOutcome {
  sqsMessageId: string;
  action: MessageAction;
  /** Status da transação (ACKED), código do erro (RETRY/DEAD_LETTERED) ou motivo (RELEASED/HELD). */
  detail: string;
}

export interface SettlerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  visibilityBackoff: ExponentialBackoff;
}

interface SettlerLogger {
  warn(message: unknown): void;
  error(message: unknown): void;
}

/** Teto do `VisibilityTimeout` no SQS: 12 h. */
const MAX_VISIBILITY_SECONDS = 43_200;

/**
 * Destino de cada mensagem recebida (§10): ack, nova tentativa com backoff, DLQ, devolução no
 * shutdown ou retenção para preservar a ordem do grupo FIFO. Só fala com o SQS; a decisão de
 * qual destino usar é do consumer.
 */
export class SqsMessageSettler {
  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SettlerOptions,
    private readonly logger: SettlerLogger,
    private readonly metrics: Metrics,
  ) {}

  /** Processada (ou rejeitada por regra, pendente, replay): remove da fila. Só depois do commit. */
  async ack(message: Message, status: string): Promise<MessageOutcome> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    return { sqsMessageId: idOf(message), action: 'ACKED', detail: status };
  }

  /** Transitório: a mensagem volta a ficar visível depois do backoff (cresce a cada recebimento). */
  async retryLater(message: Message, receiveCount: number, code: string): Promise<MessageOutcome> {
    const visibility = this.retryVisibilitySeconds(receiveCount);
    this.metrics.retries.inc({ component: 'sqs_consumer', reason: code });
    this.logger.warn({ msg: 'message will be retried', receiveCount, code, visibility });
    await this.changeVisibility(message, visibility);
    return { sqsMessageId: idOf(message), action: 'RETRY_SCHEDULED', detail: code };
  }

  /** Permanente ou tentativas esgotadas: copia para a DLQ com o motivo e remove da fila de origem. */
  async deadLetter(message: Message, reason: string): Promise<MessageOutcome> {
    this.metrics.deadLettered.inc({ reason: reason.split(':')[0] ?? reason });
    this.logger.error({ msg: 'message sent to DLQ', reason });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          consumer: { DataType: 'String', StringValue: this.options.consumerName },
        },
      }),
    );
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    return { sqsMessageId: idOf(message), action: 'DEAD_LETTERED', detail: reason };
  }

  /**
   * Mensagem posterior a uma reagendada no mesmo grupo: não processa e fica invisível pelo
   * mesmo tempo, para não passar à frente dela. Não conta como falha (o receiveCount sobe,
   * mas a mensagem nem chegou ao use case).
   */
  async holdForGroupOrder(message: Message, visibility: number): Promise<MessageOutcome> {
    const sqsMessageId = idOf(message);
    try {
      await this.changeVisibility(message, visibility);
    } catch (error) {
      // Sem a mudança, ela volta no fim do visibility timeout da fila: a ordem do grupo continua garantida pela inbox e pelo SQS.
      this.logger.error({ msg: 'sqs operation failed while holding message', sqsMessageId, error: errorMessage(error) });
    }
    return { sqsMessageId, action: 'HELD_FOR_GROUP_ORDER', detail: 'GROUP_ORDER' };
  }

  /** Shutdown: devolve imediatamente a mensagem não iniciada para outra instância. */
  async release(message: Message): Promise<MessageOutcome> {
    await this.changeVisibility(message, 0);
    return { sqsMessageId: idOf(message), action: 'RELEASED', detail: 'shutdown' };
  }

  retryVisibilitySeconds(receiveCount: number): number {
    const seconds = this.options.visibilityBackoff.delaySecondsFor(receiveCount - 1);
    return seconds > MAX_VISIBILITY_SECONDS ? MAX_VISIBILITY_SECONDS : seconds;
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
    );
  }
}

/** Atributo malformado não pode prender a mensagem num loop: assume primeira entrega. */
export function receiveCountOf(message: Message): number {
  try {
    return parsePositiveInteger(message.Attributes?.ApproximateReceiveCount ?? '1', 'ApproximateReceiveCount');
  } catch {
    return 1;
  }
}

function idOf(message: Message): string {
  return message.MessageId ?? 'unknown';
}
