import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type AppInstance, Cluster, messagingEnv } from '../helpers/cluster.ts';
import { assertLedgerInvariant, connectApp, connectOwner, execute, migrateUp } from '../helpers/database.ts';
import { HttpClient, wager, type WagerPayload } from '../helpers/http-client.ts';
import { createTestQueues, drainVisible, sendRaw, type TestQueues, testSqsClient, wagerEnvelope } from '../helpers/messaging.ts';

/**
 * §13 com processos reais: ≥ 3 instâncias da aplicação (`bun src/main.ts`), cada uma com o
 * próprio pool de conexões, consumer SQS e workers, contra o mesmo PostgreSQL e as mesmas filas.
 */
let db: MikroORM;
let sqs: SQSClient;
let cluster: Cluster;

beforeAll(async () => {
  const owner = await connectOwner();
  await migrateUp(owner);
  await owner.close(true);
  db = await connectApp();
  sqs = testSqsClient();
});

afterEach(async () => {
  await cluster?.stopAll('SIGKILL');
});

afterAll(async () => {
  sqs.destroy();
  await db.close(true);
});

// ------------------------------------------------------------------ helpers

interface Wallet {
  walletId: string;
  playerId: string;
}

/** Cada instância do cluster é acessada pelo mesmo cliente HTTP dos testes em processo. */
function client(instance: AppInstance): HttpClient {
  return new HttpClient(instance.baseUrl);
}

function createWallet(instance: AppInstance, amount: string): Promise<Wallet> {
  return client(instance).createWallet(amount);
}

function submit(instance: AppInstance, body: WagerPayload) {
  return client(instance).submit(body);
}

async function debits(walletId: string): Promise<number> {
  return (await execute(db, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).length;
}

async function balanceMinor(walletId: string): Promise<bigint> {
  const [row] = await execute<{ b: string }>(db, 'select balance_minor::text as b from wallets where id = ?', [walletId]);
  return BigInt(row?.b ?? '-1');
}

/** Invariante final de todos os testes (§13), numa única consulta para o conjunto inteiro. */
function assertGlobalInvariant(walletIds: string[]): Promise<void> {
  return assertLedgerInvariant(db, walletIds);
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

/** Nenhuma pendência para as wallets do teste: transações decididas e eventos publicados. */
async function drained(walletIds: string[]): Promise<boolean> {
  const ids = `{${walletIds.join(',')}}`;
  const [row] = await execute<{ pending: number; unpublished: number }>(
    db,
    `select (select count(*)::int from wager_transactions where wallet_id = any(?) and status = 'PENDING_REFERENCE') as pending,
            (select count(*)::int from outbox_messages where aggregate_id = any(?) and published_at is null) as unpublished`,
    [ids, ids],
  );
  return row?.pending === 0 && row.unpublished === 0;
}

function sendEnvelope(queues: TestQueues, data: Record<string, unknown>, messageId?: string) {
  const envelope = wagerEnvelope(data, messageId);
  return { envelope, sent: sendRaw(sqs, queues.wager, JSON.stringify(envelope), String(data['walletId'])) };
}

function wagerData(wallet: Wallet, kind: string, amount: string, overrides: Partial<WagerPayload> = {}) {
  const body = wager(wallet, kind, amount, overrides);
  return { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` };
}

// -------------------------------------------------------------------- tests

describe('§13 conc. 4 — três instâncias simultâneas via HTTP', () => {
  test('mesma aposta 50× espalhada por 3 instâncias → um único débito', async () => {
    cluster = new Cluster();
    const instances = await cluster.start(3);
    const wallet = await createWallet(instances[0]!, '1000.00');
    const body = wager(wallet, 'BET', '25.00');

    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(instances[i % 3]!, body)));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await balanceMinor(wallet.walletId)).toBe(97_500n);
    await assertGlobalInvariant([wallet.walletId]);
  });

  test('§8 entre instâncias: 100.00 e duas apostas de 80.00 em processos diferentes (10 rodadas)', async () => {
    cluster = new Cluster();
    const instances = await cluster.start(3);
    const wallets: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const wallet = await createWallet(instances[round % 3]!, '100.00');
      wallets.push(wallet.walletId);
      const [a, b] = await Promise.all([
        submit(instances[round % 3]!, wager(wallet, 'BET', '80.00')),
        submit(instances[(round + 1) % 3]!, wager(wallet, 'BET', '80.00')),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect([a, b].find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceMinor(wallet.walletId)).toBe(2_000n);
      expect(await debits(wallet.walletId)).toBe(1);
    }
    await assertGlobalInvariant(wallets);
  });

  test('carga mista em 3 instâncias: 15 wallets × 20 operações concorrentes', async () => {
    cluster = new Cluster();
    const instances = await cluster.start(3);
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => createWallet(instances[i % 3]!, '50.00')));
    const operations = wallets.flatMap((wallet, w) =>
      Array.from({ length: 20 }, (_, i) => ({
        instance: instances[(w + i) % 3]!,
        body: i % 4 === 0 ? wager(wallet, 'WIN', '3.00') : wager(wallet, 'BET', '7.00'),
      })),
    );
    const responses = await Promise.all(operations.map((op) => submit(op.instance, op.body)));
    expect(responses.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    expect(responses.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    await assertGlobalInvariant(wallets.map((w) => w.walletId));
  });
});

describe('§13 conc. 4 — três consumers SQS e três publishers simultâneos', () => {
  test('mensagens (com redeliveries e ROLLBACK antes da BET) processadas exatamente uma vez', async () => {
    const queues = await createTestQueues(sqs, 5, 3);
    try {
      cluster = new Cluster();
      const instances = await cluster.start(3, { env: messagingEnv(queues.names) });
      const wallets = await Promise.all(Array.from({ length: 5 }, (_, i) => createWallet(instances[i % 3]!, '100.00')));
      const walletIds = wallets.map((w) => w.walletId);

      for (const wallet of wallets) {
        const sends: Promise<unknown>[] = [];
        for (let i = 0; i < 8; i += 1) {
          const { envelope, sent } = sendEnvelope(queues, wagerData(wallet, 'BET', '1.00'));
          sends.push(sent);
          if (i % 4 === 0) {
            // Redelivery do produtor: mesmo messageId e mesmo conteúdo, outro dedup id no SQS.
            sends.push(sendRaw(sqs, queues.wager, JSON.stringify(envelope), wallet.walletId));
          }
        }
        // ROLLBACK chega antes da BET referenciada (mesmo grupo FIFO, ordem preservada).
        const betId = `bet-${randomUUID()}`;
        sends.push(sendEnvelope(queues, wagerData(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: betId })).sent);
        sends.push(sendEnvelope(queues, wagerData(wallet, 'BET', '5.00', { externalTransactionId: betId })).sent);
        await Promise.all(sends);
      }

      await waitFor('all wager messages processed and events published', async () => {
        const [row] = await execute<{ n: number }>(
          db,
          `select count(*)::int as n from wager_transactions where wallet_id = any(?) and kind <> 'OPENING' and status <> 'PENDING_REFERENCE'`,
          [`{${walletIds.join(',')}}`],
        );
        return row?.n === wallets.length * 10 && (await drained(walletIds));
      });

      for (const wallet of wallets) {
        // 8 BETs de 1.00 + BET de 5.00 revertida = 92.00; redeliveries não debitam de novo.
        expect(await balanceMinor(wallet.walletId)).toBe(9_200n);
        expect(await debits(wallet.walletId)).toBe(9);
      }
      expect(await drainVisible(sqs, queues.dlq, 1)).toHaveLength(0);
      await assertGlobalInvariant(walletIds);

      // Todos os eventos de integração dessas wallets chegaram ao broker.
      const expected = await execute<{ id: string }>(db, 'select id from outbox_messages where aggregate_id = any(?)', [
        `{${walletIds.join(',')}}`,
      ]);
      // A fila também recebe o backlog do banco de testes (outros arquivos): consome até achar todos os nossos.
      const missing = new Set(expected.map((row) => row.id));
      await waitFor('all integration events of the test wallets received', async () => {
        for (const message of await drainVisible(sqs, queues.events, 5)) missing.delete(message.Attributes?.['MessageDeduplicationId'] ?? '');
        return missing.size === 0;
      });
      expect(missing.size).toBe(0);

      // Os três processos trabalharam (a carga não ficou presa numa instância só).
      const processedBy = await Promise.all(
        instances.map(async (i) => /wagering_transactions_total\{[^}]*source="sqs"[^}]*\} [1-9]/.test(await i.metrics())),
      );
      expect(processedBy.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    } finally {
      await cluster.stopAll('SIGKILL');
      await queues.delete();
    }
  }, 90_000);
});

describe('§13 conc. 5 — worker morto depois do commit e antes do ack', () => {
  test('a redelivery é absorvida pela inbox: um débito, fila e DLQ vazias, replay contabilizado', async () => {
    const queues = await createTestQueues(sqs, 5, 3); // visibility timeout de 3 s
    try {
      cluster = new Cluster();
      const crasher = await cluster.add('crasher', {
        env: messagingEnv(queues.names, { FAULT_INJECTION: 'after_commit_before_ack', OUTBOX_PUBLISHER_ENABLED: 'false' }),
      });
      const wallet = await createWallet(crasher, '100.00');
      const { envelope, sent } = sendEnvelope(queues, wagerData(wallet, 'BET', '40.00'));
      await sent;

      // O processo commita e se mata com SIGKILL antes do DeleteMessage.
      await crasher.exited();
      expect(crasher.signalCode).toBe('SIGKILL');
      expect(await debits(wallet.walletId)).toBe(1);
      const [inbox] = await execute<{ processed: boolean }>(
        db,
        'select processed_at is not null as processed from inbox_messages where message_id = ?',
        [envelope.messageId],
      );
      expect(inbox).toEqual({ processed: true });

      // Outra instância recebe a mesma mensagem quando a visibilidade expira.
      const survivor = await cluster.add('survivor', { env: messagingEnv(queues.names) });
      await waitFor('redelivery acknowledged by the survivor', async () =>
        /wagering_duplicates_detected_total\{kind="idempotent_replay",source="sqs"\} 1/.test(await survivor.metrics()),
      );

      expect(await debits(wallet.walletId)).toBe(1);
      expect(await balanceMinor(wallet.walletId)).toBe(6_000n);
      await waitFor('source queue empty', async () => (await drainVisible(sqs, queues.wager, 1)).length === 0, 10_000);
      expect(await drainVisible(sqs, queues.dlq, 1)).toHaveLength(0);
      const inboxRows = await execute(db, 'select 1 from inbox_messages where message_id = ?', [envelope.messageId]);
      expect(inboxRows).toHaveLength(1);
      await assertGlobalInvariant([wallet.walletId]);
    } finally {
      await cluster.stopAll('SIGKILL');
      await queues.delete();
    }
  }, 60_000);
});

describe('§10 — SIGTERM com mensagens em processamento', () => {
  test('a instância encerra graciosamente; nada se perde e nada é processado duas vezes', async () => {
    const queues = await createTestQueues(sqs, 5, 3);
    try {
      cluster = new Cluster();
      const draining = await cluster.add('draining', { env: messagingEnv(queues.names) });
      const wallet = await createWallet(draining, '100.00');
      await Promise.all(Array.from({ length: 40 }, () => sendEnvelope(queues, wagerData(wallet, 'BET', '1.00')).sent));

      await waitFor('first messages processed', async () => (await debits(wallet.walletId)) > 0, 15_000);
      const exitCode = await draining.stop('SIGTERM');
      expect([0, 143]).toContain(exitCode); // shutdown gracioso (o Nest re-emite o sinal após drenar)
      expect(draining.logs()).not.toContain('"level":"fatal"');

      const takeover = await cluster.add('takeover', { env: messagingEnv(queues.names) });
      await waitFor('remaining messages processed by the new instance', async () => (await debits(wallet.walletId)) === 40);
      await Bun.sleep(500);
      expect(await debits(wallet.walletId)).toBe(40);
      expect(await balanceMinor(wallet.walletId)).toBe(6_000n);
      expect(await drainVisible(sqs, queues.dlq, 1)).toHaveLength(0);
      await assertGlobalInvariant([wallet.walletId]);
      await takeover.stop('SIGTERM');
    } finally {
      await cluster.stopAll('SIGKILL');
      await queues.delete();
    }
  }, 60_000);
});

describe('§13 conc. 8 — reinício do serviço no meio da carga', () => {
  test('SIGKILL em todas as instâncias durante a carga, reinício e consistência final comprovada', async () => {
    const queues = await createTestQueues(sqs, 10, 3);
    try {
      cluster = new Cluster();
      const first = await cluster.start(3, { env: messagingEnv(queues.names) }, 'before');
      const wallets = await Promise.all(Array.from({ length: 8 }, (_, i) => createWallet(first[i % 3]!, '100.00')));
      const walletIds = wallets.map((w) => w.walletId);

      // Carga: HTTP em paralelo + mensagens SQS (inclui ROLLBACK antes da BET).
      const httpPayloads = wallets.flatMap((wallet) => Array.from({ length: 12 }, () => wager(wallet, 'BET', '3.00')));
      const sends: Promise<unknown>[] = [];
      for (const wallet of wallets) {
        for (let i = 0; i < 6; i += 1) sends.push(sendEnvelope(queues, wagerData(wallet, 'BET', '2.00')).sent);
        const betId = `bet-${randomUUID()}`;
        sends.push(sendEnvelope(queues, wagerData(wallet, 'REFUND', '4.00', { referenceExternalTransactionId: betId })).sent);
        sends.push(sendEnvelope(queues, wagerData(wallet, 'BET', '4.00', { externalTransactionId: betId })).sent);
      }
      await Promise.all(sends);
      const inflight = httpPayloads.map((body, i) => submit(first[i % 3]!, body).catch(() => undefined));

      // Queda abrupta de todas as instâncias no meio do processamento.
      await Bun.sleep(150);
      await Promise.all(first.map((instance) => instance.stop('SIGKILL')));
      await Promise.all(inflight);
      // A queda precisa ter interrompido trabalho de verdade; senão o teste não prova recuperação.
      const [atCrash] = await execute<{ n: number }>(
        db,
        `select count(*)::int as n from wager_transactions where wallet_id = any(?) and kind <> 'OPENING' and status <> 'PENDING_REFERENCE'`,
        [`{${walletIds.join(',')}}`],
      );
      expect(atCrash?.n).toBeLessThan(wallets.length * (12 + 8));

      // Reinício: novas instâncias retomam fila, outbox e pendências.
      const second = await cluster.start(3, { env: messagingEnv(queues.names) }, 'after');
      // O provedor reenvia o que não teve resposta (idempotência garante efeito único).
      const retried = await Promise.all(httpPayloads.map((body, i) => submit(second[i % 3]!, body)));
      expect(retried.every((r) => r.status === 201 || r.status === 422)).toBe(true);

      await waitFor('queue, outbox and pending references drained after restart', async () => {
        const [row] = await execute<{ n: number }>(
          db,
          `select count(*)::int as n from wager_transactions where wallet_id = any(?) and kind <> 'OPENING'`,
          [`{${walletIds.join(',')}}`],
        );
        return row?.n === wallets.length * (12 + 8) && (await drained(walletIds));
      }, 60_000);

      // Cada operação produziu no máximo um efeito: 12×3.00 (HTTP) + 6×2.00 (SQS) + BET 4.00 reembolsada = 48.00.
      for (const wallet of wallets) expect(await balanceMinor(wallet.walletId)).toBe(5_200n);
      expect(await drainVisible(sqs, queues.dlq, 1)).toHaveLength(0);
      await assertGlobalInvariant(walletIds);
    } finally {
      await cluster.stopAll('SIGKILL');
      await queues.delete();
    }
  }, 120_000);
});
