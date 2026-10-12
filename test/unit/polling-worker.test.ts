import { describe, expect, test } from 'bun:test';
import { PollingWorker } from '../../src/shared/infrastructure/workers/polling-worker.ts';

const silent = { error: () => undefined };

describe('PollingWorker', () => {
  test('drena o backlog sem dormir e dorme quando não há trabalho', async () => {
    const backlog = [3, 2, 0, 0];
    let ticks = 0;
    const worker = new PollingWorker('test', 50, async () => {
      ticks += 1;
      return backlog.shift() ?? 0;
    }, silent);
    worker.start();
    await Bun.sleep(20);
    expect(ticks).toBe(3); // 3 e 2 em sequência, depois dorme após o 0
    await worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  test('stop() acorda o sono e espera o tick em andamento terminar', async () => {
    let finished = false;
    const worker = new PollingWorker('test', 60_000, async () => {
      await Bun.sleep(30);
      finished = true;
      return 0;
    }, silent);
    worker.start();
    await Bun.sleep(5);
    const started = Date.now();
    await worker.stop();
    expect(finished).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('stop() tem prazo: um tick que nunca termina não segura o shutdown', async () => {
    const warnings: unknown[] = [];
    const worker = new PollingWorker('stuck', 10, () => new Promise<number>(() => undefined), {
      error: () => undefined,
      warn: (message: unknown) => warnings.push(message),
    }, 50);
    worker.start();
    await Bun.sleep(5);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(worker.isRunning).toBe(false);
    expect(warnings).toEqual([{ msg: 'stuck stop timed out', timeoutMs: 50 }]);
  });

  test('erro num tick é logado e o loop continua', async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const worker = new PollingWorker('test', 10, async () => {
      ticks += 1;
      if (ticks === 1) throw new Error('boom');
      return 0;
    }, { error: (message: unknown) => errors.push(message) });
    worker.start();
    await Bun.sleep(40);
    await worker.stop();
    expect(errors).toHaveLength(1);
    expect(ticks).toBeGreaterThan(1);
  });

  test('start() é idempotente', async () => {
    let ticks = 0;
    const worker = new PollingWorker('test', 60_000, async () => {
      ticks += 1;
      return 0;
    }, silent);
    worker.start();
    worker.start();
    await Bun.sleep(10);
    await worker.stop();
    expect(ticks).toBe(1);
  });
});
