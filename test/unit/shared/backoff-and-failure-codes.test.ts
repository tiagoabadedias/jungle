import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error.ts';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff.ts';
import { FAILURE_CODES, FailureCode } from '../../../src/shared/domain/failure-code.ts';

describe('ExponentialBackoff', () => {
  const backoff = ExponentialBackoff.create({ baseDelayMs: 2_000, maxDelayMs: 300_000 });

  test('dobra a cada tentativa e respeita o teto', () => {
    expect([0, 1, 2, 3, 7, 8, 20].map((attempt) => backoff.delayFor(attempt))).toEqual([
      2_000, 4_000, 8_000, 16_000, 256_000, 300_000, 300_000,
    ]);
  });

  test('tentativa negativa é tratada como zero', () => {
    expect(backoff.delayFor(-1)).toBe(2_000);
  });

  test('tentativa que não é inteira (NaN, fração) é recusada em vez de gerar Invalid Date', () => {
    expect(() => backoff.delayFor(Number.NaN)).toThrow(InvariantViolationError);
    expect(() => backoff.nextAttemptAt(new Date(0), 1.5)).toThrow(InvariantViolationError);
  });

  test('nextAttemptAt soma o atraso ao instante informado', () => {
    expect(backoff.nextAttemptAt(new Date(0), 1)).toEqual(new Date(4_000));
  });

  test.each([
    [{ baseDelayMs: 0, maxDelayMs: 10 }],
    [{ baseDelayMs: 1.5, maxDelayMs: 10 }],
    [{ baseDelayMs: 10, maxDelayMs: 5 }],
  ])('configuração inválida %p é rejeitada', (props) => {
    expect(() => ExponentialBackoff.create(props)).toThrow(InvariantViolationError);
  });
});

describe('FailureCode — taxonomia estável', () => {
  test('todo código tem metadados para o provedor decidir o que fazer', () => {
    for (const code of Object.values(FailureCode)) {
      const info = FAILURE_CODES[code];
      expect(info).toBeDefined();
      expect(info.description.length).toBeGreaterThan(0);
      expect(['GIVE_UP', 'FIX_PAYLOAD', 'ESCALATE']).toContain(info.action);
    }
  });

  test('valores são strings estáveis em SCREAMING_SNAKE_CASE', () => {
    for (const code of Object.values(FailureCode)) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  test('saldo insuficiente em aposta e em reversão têm códigos distintos (§7.9)', () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalInsufficientFunds);
  });
});
