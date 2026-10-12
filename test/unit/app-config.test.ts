import { describe, expect, test } from 'bun:test';
import { loadAppConfig } from '../../src/shared/infrastructure/config/app-config.ts';

const base = { DATABASE_URL: 'postgres://x' };

describe('loadAppConfig', () => {
  test('defaults seguros', () => {
    const config = loadAppConfig(base);
    expect(config.port).toBe(3000);
    expect(config.consumer.maxAttempts).toBe(5);
    expect(config.consumer.faultInjection).toBeUndefined();
    expect(config.referenceRetry.maxAttempts).toBe(10);
  });

  test.each([
    [{ DATABASE_URL: '' }, 'DATABASE_URL'],
    [{ ...base, PORT: 'abc' }, 'PORT'],
    [{ ...base, PORT: '0' }, 'PORT'],
    [{ ...base, SQS_CONSUMER_ENABLED: 'yes' }, 'SQS_CONSUMER_ENABLED'],
    [{ ...base, FAULT_INJECTION: 'kill_everything' }, 'FAULT_INJECTION'],
    [{ ...base, SQS_WAIT_TIME_SECONDS: '21' }, 'SQS_WAIT_TIME_SECONDS'],
    [{ ...base, SQS_MAX_MESSAGES: '11' }, 'SQS_MAX_MESSAGES'],
  ])('configuração inválida é recusada no boot (%p)', (env, variable) => {
    expect(() => loadAppConfig(env)).toThrow(variable);
  });

  test('injeção de falha é recusada em produção', () => {
    expect(() => loadAppConfig({ ...base, NODE_ENV: 'production', FAULT_INJECTION: 'after_commit_before_ack' })).toThrow('production');
    expect(loadAppConfig({ ...base, FAULT_INJECTION: 'after_commit_before_ack' }).consumer.faultInjection).toBe('after_commit_before_ack');
  });
});
