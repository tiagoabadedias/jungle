import { afterAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { testSqsClient } from '../../helpers/messaging.ts';

/**
 * Filas criadas pelo init script (`infra/ministack/ready.d/01-sqs.sh`). O MiniStack aceita uma
 * DLQ standard para uma fila FIFO (a AWS rejeita), então a configuração é conferida aqui.
 */
const sqs = testSqsClient();

afterAll(() => sqs.destroy());

async function attributes(name: string) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  const output = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }));
  return output.Attributes ?? {};
}

describe('filas do ambiente (§10)', () => {
  test.each([['wager-transactions.fifo'], ['wager-transactions-dlq.fifo'], ['wallet-events.fifo']])('%s existe e é FIFO', async (name) => {
    expect((await attributes(name))['FifoQueue']).toBe('true');
  });

  test('a fila de entrada redireciona para a DLQ FIFO após um limite de recebimentos', async () => {
    const redrive = JSON.parse((await attributes('wager-transactions.fifo'))['RedrivePolicy'] ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string | number;
    };
    expect(redrive.deadLetterTargetArn).toEndWith(':wager-transactions-dlq.fifo');
    expect(Number.parseInt(String(redrive.maxReceiveCount), 10)).toBe(5);
  });
});
