import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/shared/domain/domain-error.ts';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff.ts';
import { InboxMessage } from '../../../src/messaging/domain/inbox-message.ts';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';
import { WalletBalanceChanged } from '../../../src/wallet/domain/events/wallet-balance-changed.ts';
import { brl, NOW, openWallet, WALLET_ID } from '../fixtures.ts';

const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('InboxMessage', () => {
  test('receive → markProcessed; segunda marcação é erro', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-123', consumerName: 'wager', payloadHash: 'h1', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at(10));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(at(10));
    expect(() => inbox.markProcessed(at(20))).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload distingue redelivery de messageId reutilizado com outro conteúdo', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h1', receivedAt: NOW });
    expect(inbox.matchesPayload('h1')).toBe(true);
    expect(inbox.matchesPayload('h2')).toBe(false);
  });

  test('rehydrate preserva processedAt', () => {
    const inbox = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: NOW, processedAt: at(5) });
    expect(inbox.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const backoff = ExponentialBackoff.create({ baseDelayMs: 1_000, maxDelayMs: 60_000 });

  const enqueue = () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit({ money: brl('1.00'), transactionId: 't', entryId: 'e', at: NOW });
    return OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, entry, { eventId: 'evt-1', correlationId: 'c', occurredAt: NOW }),
    );
  };

  test('enqueue usa o envelope serializado e o eventId como id', () => {
    const message = enqueue();
    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe(WALLET_ID);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload['eventType']).toBe('WalletBalanceChanged');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry incrementa attempts e adia com backoff exponencial', () => {
    const message = enqueue();
    message.scheduleRetry(NOW, backoff);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1_000));
    expect(message.isDue(at(999))).toBe(false);
    expect(message.isDue(at(1_000))).toBe(true);
    message.scheduleRetry(NOW, backoff);
    expect(message.nextAttemptAt).toEqual(at(2_000));
  });

  test('markPublished encerra; publicar ou reagendar de novo é erro', () => {
    const message = enqueue();
    message.markPublished(at(5));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(10))).toBe(false);
    expect(message.publishedAt).toEqual(at(5));
    expect(() => message.markPublished(at(6))).toThrow(InvalidTransactionStateError);
    expect(() => message.scheduleRetry(at(6), backoff)).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate reconstrói tentativas e publicação', () => {
    const message = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'evt-9' },
      occurredAt: NOW,
      attempts: 3,
      nextAttemptAt: at(8_000),
    });
    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at(7_999))).toBe(false);
    expect(Object.isFrozen(message.payload)).toBe(true);

    const published = OutboxMessage.rehydrate({
      id: 'evt-10',
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: {},
      occurredAt: NOW,
      attempts: 0,
      publishedAt: at(1),
    });
    expect(published.isPending()).toBe(false);
    expect(published.publishedAt).toEqual(at(1));
  });
});
