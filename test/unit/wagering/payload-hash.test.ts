import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, computePayloadHash, type WagerPayloadFields } from '../../../src/wagering/domain/payload-hash.ts';

const payload: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente, omite undefined e não usa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, 1] }, z: undefined })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  test('a ordem de inserção das chaves não altera o resultado', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('computePayloadHash', () => {
  test('algoritmo documentado: SHA-256 hex do JSON canônico do subconjunto de negócio', () => {
    const expectedCanonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expected = createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
    expect(computePayloadHash(payload)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  test('payload idêntico → mesmo hash, independente da ordem das chaves', () => {
    const reordered: WagerPayloadFields = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['roundId', { roundId: 'round-988' }],
    ['walletId', { walletId: 'other' }],
    ['reference', { referenceExternalTransactionId: 'bet-1' }],
  ])('mesma key com %s diferente → hash diferente (conflito, não replay)', (_, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });

  test('metadados de transporte não entram no hash', () => {
    const withTransport = { ...payload, idempotencyKey: 'provider-a:transaction-123', messageId: 'msg-1' };
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test('referência undefined equivale a ausente', () => {
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(payload));
  });
});
