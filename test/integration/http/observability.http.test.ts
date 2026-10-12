import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ShutdownState } from '../../../src/health/health.controller.ts';
import { TestApp, wager } from '../../helpers/app.ts';
import { holdWalletLock } from '../../helpers/database.ts';

let api: TestApp;

beforeAll(async () => {
  api = await TestApp.start({ LOCK_TIMEOUT_MS: '300' });
});

afterAll(async () => {
  await api.stop();
});

describe('health checks (§9, §12)', () => {
  test('liveness e readiness (PostgreSQL + SQS alcançáveis)', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    const ready = await api.request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  test('durante o shutdown a readiness responde 503 (o balanceador para de mandar tráfego)', async () => {
    const other = await TestApp.start();
    other.app.get(ShutdownState).beforeApplicationShutdown();
    const ready = await other.request('GET', '/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'unavailable', shuttingDown: true });
    await other.stop();
  });
});

describe('GET /metrics', () => {
  test('expõe transações por status, latência HTTP por rota e o outbox lag', async () => {
    const wallet = await api.createWallet('100.00');
    await api.submit(wager(wallet, 'BET', '10.00'));
    await api.submit(wager(wallet, 'BET', '500.00'));

    const response = await fetch(`${api.baseUrl}/metrics`);
    const text = await response.text();
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toMatch(/wagering_transactions_total\{status="PROCESSED",kind="BET",source="http"\} \d+/);
    expect(text).toMatch(/wagering_transactions_total\{status="REJECTED",kind="BET",source="http"\} \d+/);
    expect(text).toContain('wagering_http_request_duration_seconds_count{method="POST",route="/wagering/transactions",status="201"}');
    expect(text).toMatch(/wagering_outbox_lag_seconds \d/);
    // Publisher desligado no app de teste: os eventos acima seguem pendentes (prova que a consulta da outbox está ligada).
    expect(text).toMatch(/wagering_outbox_pending [1-9]\d*/);
    expect(text).not.toContain(wallet.walletId); // nenhuma série por id
  });

  test('lock não obtido a tempo: 503 com Retry-After e conflito de lock contabilizado', async () => {
    const wallet = await api.createWallet('100.00');
    const release = await holdWalletLock(api.db, wallet.walletId);
    const response = await api.submit(wager(wallet, 'BET', '1.00'));
    await release();

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    const text = await (await fetch(`${api.baseUrl}/metrics`)).text();
    expect(text).toMatch(/wagering_lock_conflicts_total\{sqlstate="55P03"\} [1-9]/);
  });
});
