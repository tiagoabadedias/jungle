import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff.ts';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../../src/wagering/application/process-wager-transaction.use-case.ts';
import { WagerTransactionsConsumer } from '../../../src/wagering/infrastructure/sqs/wager-transactions.consumer.ts';
import { execute, holdWalletLock } from '../../helpers/database.ts';
import { drainVisible, MessagingHarness, wagerEnvelope } from '../../helpers/messaging.ts';

/** Consumer de `wager-transactions.fifo` contra MiniStack e PostgreSQL reais (§10, §13). */
let h: MessagingHarness;

beforeAll(async () => {
  h = await MessagingHarness.start();
});

// Invariante final (§13): wallet.balance == saldo reconstruído pelo ledger.
afterEach(async () => {
  await h.assertLedgerInvariant();
});

afterAll(async () => {
  await h.stop();
});

async function debits(walletId: string): Promise<number> {
  return (await execute(h.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).length;
}

async function balance(walletId: string): Promise<string> {
  const [row] = await execute<{ b: string }>(h.orm, 'select balance_minor::text as b from wallets where id = ?', [walletId]);
  return row?.b ?? 'missing';
}

describe('processamento e ack após o commit', () => {
  test('mensagem válida: processa pelo mesmo use case do HTTP, grava inbox e confirma (ack)', async () => {
    const wallet = await h.createWallet('100.00');
    const envelope = wagerEnvelope(h.wagerData(wallet, 'BET', '25.00'));
    await h.send(envelope, wallet.walletId);

    const outcomes = await h.consumer().pollOnce();

    expect(outcomes).toEqual([{ sqsMessageId: expect.any(String), action: 'ACKED', detail: 'PROCESSED' }]);
    expect(await balance(wallet.walletId)).toBe('7500');
    const inbox = await execute<{ processed: boolean }>(
      h.orm,
      'select processed_at is not null as processed from inbox_messages where consumer_name = ? and message_id = ?',
      ['wager-transactions-consumer', envelope.messageId],
    );
    expect(inbox).toEqual([{ processed: true }]);
    expect(await drainVisible(h.sqs, h.queues.wager, 1)).toHaveLength(0); // removida da fila
  });

  test('rejeição de negócio é terminal: ack, não vai para a DLQ', async () => {
    const wallet = await h.createWallet('1.00');
    await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '5.00')), wallet.walletId);
    const [outcome] = await h.consumer().pollOnce();
    expect(outcome).toMatchObject({ action: 'ACKED', detail: 'REJECTED' });
    expect(await drainVisible(h.sqs, h.queues.dlq, 1)).toHaveLength(0);
  });
});

describe('inbox persistente e redelivery (§10)', () => {
  test('a mesma mensagem entregue de novo não duplica o débito', async () => {
    const wallet = await h.createWallet('100.00');
    const envelope = wagerEnvelope(h.wagerData(wallet, 'BET', '30.00'));
    // Dois envios com MessageDeduplicationId diferentes: o SQS entrega os dois (redelivery do produtor).
    await h.send(envelope, wallet.walletId);
    await h.send(envelope, wallet.walletId);

    const outcomes = [...(await h.consumer().pollOnce()), ...(await h.consumer().pollOnce())];

    expect(outcomes.map((o) => o.action)).toEqual(['ACKED', 'ACKED']);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await balance(wallet.walletId)).toBe('7000');
  });

  test('transação já recebida via HTTP (mesma key): a mensagem é confirmada como replay', async () => {
    const wallet = await h.createWallet('100.00');
    const data = h.wagerData(wallet, 'BET', '10.00');
    await h.processUseCase().execute({ ...data, context: { correlationId: 'http' } } as Parameters<
      ReturnType<MessagingHarness['processUseCase']>['execute']
    >[0]);
    await h.send(wagerEnvelope(data), wallet.walletId);
    const [outcome] = await h.consumer().pollOnce();
    expect(outcome).toMatchObject({ action: 'ACKED', detail: 'PROCESSED' });
    expect(await debits(wallet.walletId)).toBe(1);
  });
});

describe('erros permanentes → DLQ (§10)', () => {
  test.each([
    ['JSON inválido', (data: Record<string, unknown>) => `{not json ${String(data['walletId'])}`],
    ['contrato violado (amount number)', (data: Record<string, unknown>) => JSON.stringify(wagerEnvelope({ ...data, money: { amount: 10, currency: 'BRL' } }))],
    ['kind OPENING', (data: Record<string, unknown>) => JSON.stringify(wagerEnvelope({ ...data, kind: 'OPENING' }))],
    ['type desconhecido', (data: Record<string, unknown>) => JSON.stringify({ ...wagerEnvelope(data), type: 'Other' })],
  ])('%s → DLQ com o motivo, removida da fila de origem', async (_, build) => {
    const wallet = await h.createWallet('100.00');
    await h.send(build(h.wagerData(wallet, 'BET', '1.00')), wallet.walletId);

    const [outcome] = await h.consumer().pollOnce();

    expect(outcome).toMatchObject({ action: 'DEAD_LETTERED', detail: 'INVALID_MESSAGE' });
    const dead = (await drainVisible(h.sqs, h.queues.dlq)).filter((m) => m.Body?.includes(wallet.walletId));
    expect(dead).toHaveLength(1);
    expect(dead[0]?.MessageAttributes?.['failureReason']?.StringValue).toBe('INVALID_MESSAGE');
    expect(await drainVisible(h.sqs, h.queues.wager, 1)).toHaveLength(0);
    expect(await balance(wallet.walletId)).toBe('10000');
  });

  test('mesma idempotency key com payload diferente → DLQ IDEMPOTENCY_CONFLICT', async () => {
    const wallet = await h.createWallet('100.00');
    const data = h.wagerData(wallet, 'BET', '10.00');
    await h.send(wagerEnvelope(data), wallet.walletId);
    await h.send(wagerEnvelope({ ...data, money: { amount: '11.00', currency: 'BRL' } }), wallet.walletId);
    const outcomes = [...(await h.consumer().pollOnce()), ...(await h.consumer().pollOnce())];
    expect(outcomes.map((o) => o.action)).toEqual(['ACKED', 'DEAD_LETTERED']);
    expect(outcomes[1]?.detail).toBe('IDEMPOTENCY_CONFLICT');
    expect(await debits(wallet.walletId)).toBe(1);
  });

  test('messageId reutilizado com outro conteúdo → DLQ MESSAGE_CONFLICT', async () => {
    const wallet = await h.createWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '10.00'), messageId), wallet.walletId);
    await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '20.00'), messageId), wallet.walletId);
    const outcomes = [...(await h.consumer().pollOnce()), ...(await h.consumer().pollOnce())];
    expect(outcomes.map((o) => o.detail)).toEqual(['PROCESSED', 'MESSAGE_CONFLICT']);
    expect(await debits(wallet.walletId)).toBe(1);
  });

  test('wallet inexistente → DLQ WALLET_NOT_FOUND', async () => {
    await h.send(wagerEnvelope(h.wagerData({ walletId: randomUUID(), playerId: randomUUID() }, 'BET', '1.00')), 'g');
    const [outcome] = await h.consumer().pollOnce();
    expect(outcome).toMatchObject({ action: 'DEAD_LETTERED', detail: 'WALLET_NOT_FOUND' });
  });
});

describe('erros transitórios → retry com backoff; limite de tentativas → DLQ (§10)', () => {
  test('lock indisponível: mensagem volta após o backoff e é processada uma única vez', async () => {
    const wallet = await h.createWallet('100.00');
    await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '10.00')), wallet.walletId);
    const consumer = h.consumer({ lockTimeoutMs: 200 });

    const release = await holdWalletLock(h.orm, wallet.walletId);
    const [first] = await consumer.pollOnce();
    await release();

    expect(first).toMatchObject({ action: 'RETRY_SCHEDULED', detail: 'SERVICE_UNAVAILABLE' });
    expect(await consumer.pollOnce(0)).toEqual([]); // invisível durante o backoff (1 s)
    await Bun.sleep(1_200);
    const [second] = await consumer.pollOnce();
    expect(second).toMatchObject({ action: 'ACKED', detail: 'PROCESSED' });
    expect(await debits(wallet.walletId)).toBe(1);
  });

  test('ordem do grupo FIFO: depois de uma mensagem reagendada, as seguintes do mesmo grupo não passam à frente', async () => {
    const locked = await h.createWallet('100.00');
    const free = await h.createWallet('100.00');
    const other = await h.createWallet('100.00');
    const group = `group-${locked.walletId}`;
    await h.send(wagerEnvelope(h.wagerData(locked, 'BET', '10.00')), group);
    await h.send(wagerEnvelope(h.wagerData(free, 'BET', '20.00')), group); // processável, mas vem depois no grupo
    await h.send(wagerEnvelope(h.wagerData(other, 'BET', '30.00')), other.walletId); // outro grupo: segue normal
    const consumer = h.consumer({ lockTimeoutMs: 200 });

    const release = await holdWalletLock(h.orm, locked.walletId);
    const first = await consumer.pollOnce();
    await release();

    expect(first.map((o) => [o.action, o.detail])).toEqual([
      ['RETRY_SCHEDULED', 'SERVICE_UNAVAILABLE'],
      ['HELD_FOR_GROUP_ORDER', 'GROUP_ORDER'],
      ['ACKED', 'PROCESSED'],
    ]);
    expect(await debits(free.walletId)).toBe(0); // não passou à frente da mensagem reagendada
    expect(await debits(other.walletId)).toBe(1);

    await Bun.sleep(1_200); // backoff de 1 s
    const second = await consumer.pollOnce();
    expect(second.map((o) => o.action)).toEqual(['ACKED', 'ACKED']);
    expect(await balance(locked.walletId)).toBe('9000');
    expect(await balance(free.walletId)).toBe('8000');
  });

  test('tentativas esgotadas → DLQ MAX_ATTEMPTS_EXCEEDED', async () => {
    const wallet = await h.createWallet('100.00');
    await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '10.00')), wallet.walletId);
    const consumer = h.consumer({ lockTimeoutMs: 200, maxAttempts: 2 });

    const release = await holdWalletLock(h.orm, wallet.walletId);
    const [first] = await consumer.pollOnce();
    await Bun.sleep(1_200);
    const [second] = await consumer.pollOnce();
    await release();

    expect(first?.action).toBe('RETRY_SCHEDULED');
    expect(second).toMatchObject({ action: 'DEAD_LETTERED', detail: 'MAX_ATTEMPTS_EXCEEDED:SERVICE_UNAVAILABLE' });
    expect(await debits(wallet.walletId)).toBe(0);
    const dead = (await drainVisible(h.sqs, h.queues.dlq)).filter((m) => m.Body?.includes(wallet.walletId));
    expect(dead).toHaveLength(1);
    expect(dead[0]?.MessageAttributes?.['failureReason']?.StringValue).toBe('MAX_ATTEMPTS_EXCEEDED:SERVICE_UNAVAILABLE');
  });
});

describe('loop do consumer e parada graciosa', () => {
  test('consome continuamente e stop() interrompe o long polling sem esperar os 20 s', async () => {
    const wallet = await h.createWallet('100.00');
    const consumer = h.consumer({ waitTimeSeconds: 20 });
    consumer.start();
    for (let i = 0; i < 5; i += 1) await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '1.00')), wallet.walletId);

    const deadline = Date.now() + 15_000;
    while ((await debits(wallet.walletId)) < 5 && Date.now() < deadline) await Bun.sleep(100);

    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await debits(wallet.walletId)).toBe(5);
    expect(await balance(wallet.walletId)).toBe('9500');
  });

  test('SIGTERM no meio de um lote: conclui a mensagem em andamento e devolve as não iniciadas', async () => {
    const wallet = await h.createWallet('100.00');
    for (let i = 0; i < 3; i += 1) await h.send(wagerEnvelope(h.wagerData(wallet, 'BET', '1.00')), wallet.walletId);

    let consumer!: WagerTransactionsConsumer;
    let stopping: Promise<void> | undefined;
    // Use case real que dispara o stop() logo depois de concluir a primeira mensagem.
    class StopAfterFirst extends ProcessWagerTransactionUseCase {
      override async execute(command: ProcessWagerTransactionCommand) {
        const result = await super.execute(command);
        stopping ??= consumer.stop();
        return result;
      }
    }
    const useCase = new StopAfterFirst(h.unitOfWork(), h.clock, h.ids, h.referenceRetry);
    consumer = new WagerTransactionsConsumer(
      h.sqs,
      useCase,
      {
        queueUrl: h.queues.wager,
        dlqUrl: h.queues.dlq,
        consumerName: 'wager-transactions-consumer',
        waitTimeSeconds: 2,
        maxMessages: 10,
        maxAttempts: 5,
        visibilityBackoff: ExponentialBackoff.create({ baseDelayMs: 1_000, maxDelayMs: 5_000 }),
        drainTimeoutMs: 10_000,
      },
      new Logger('StopTest'),
    );
    consumer.start();
    // Prazo folgado: em máquina sobrecarregada a primeira mensagem pode demorar (só espera, não muda a asserção).
    const deadline = Date.now() + 30_000;
    while (stopping === undefined && Date.now() < deadline) await Bun.sleep(20);
    await stopping;

    expect(await debits(wallet.walletId)).toBe(1); // só a primeira foi processada
    // As outras duas voltaram para a fila imediatamente (visibilidade 0), sem esperar 30 s.
    const outcomes = await h.consumer().pollOnce();
    expect(outcomes.map((o) => o.action)).toEqual(['ACKED', 'ACKED']);
    expect(await debits(wallet.walletId)).toBe(3);
  });
});
