/**
 * Teste de carga (diferencial opcional do §14): `bun run test:load`.
 *
 * Gerador em circuito fechado: N usuários virtuais (VUs), cada um envia a próxima requisição
 * assim que recebe a resposta, por um tempo fixo, contra o gateway (nginx → réplicas da app).
 * Durante cada cenário, amostra no PostgreSQL as transações esperando lock e o outbox lag.
 * Ao final, confere o invariante `wallet.balance == ledger` em todas as wallets tocadas.
 *
 * Variáveis: LOAD_API_URL (http://localhost:43180), LOAD_DURATION_S (20), LOAD_VUS (32),
 *            LOAD_WALLETS (200), LOAD_SQS_MESSAGES (2000), LOAD_LABEL (rótulo do resultado).
 * Pré-requisito: `docker compose up -d --wait [--scale app=N]`. Usa DATABASE_URL do `.env`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { resolveQueueUrl } from '../src/shared/infrastructure/sqs/sqs-client.ts';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../src/shared/infrastructure/config/app-config.ts';
import { createOrmConfig } from '../src/shared/infrastructure/database/mikro-orm.config.ts';

const API = process.env['LOAD_API_URL'] ?? 'http://localhost:43180';
const DURATION_S = Number.parseInt(process.env['LOAD_DURATION_S'] ?? '20', 10);
const VUS = Number.parseInt(process.env['LOAD_VUS'] ?? '32', 10);
const WALLETS = Number.parseInt(process.env['LOAD_WALLETS'] ?? '200', 10);
const SQS_MESSAGES = Number.parseInt(process.env['LOAD_SQS_MESSAGES'] ?? '2000', 10);
const LABEL = process.env['LOAD_LABEL'] ?? 'run';
const run = randomUUID().slice(0, 8);

const db = await MikroORM.init(createOrmConfig({ clientUrl: requireEnv('DATABASE_URL'), poolMax: 2 }));
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env['SQS_ENDPOINT'] ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

interface Wallet {
  walletId: string;
  playerId: string;
}

interface Sample {
  latencyMs: number;
  status: number; // 0 = erro de rede
}

interface DbSample {
  lockWaiters: number;
  outboxPending: number;
  outboxLagSeconds: number;
}

// ------------------------------------------------------------------ helpers

async function post(path: string, body: unknown, key?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function createWallets(count: number, amount: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let start = 0; start < count; start += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - start) }, async () => {
        const playerId = randomUUID();
        const { status, json } = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
        if (status !== 201) throw new Error(`wallet creation failed: ${status} ${JSON.stringify(json)}`);
        return { walletId: String(json['id']), playerId };
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

function wager(wallet: Wallet, kind: 'BET' | 'WIN', amount: string) {
  const externalTransactionId = `load-${run}-${randomUUID()}`;
  return {
    providerId: 'provider-load',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${run}`,
    gameId: 'load-test',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** CPU por container no meio do cenário (`docker stats`); vazio se o Docker CLI não estiver disponível. */
async function containerCpu(): Promise<Record<string, string>> {
  const proc = Bun.spawn(['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}}'], { stdout: 'pipe', stderr: 'ignore' });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const cpu: Record<string, string> = {};
  for (const line of text.trim().split('\n')) {
    const [name, value] = line.split(' ');
    if (name?.startsWith('jungle-') && value !== undefined && !value.startsWith('0.0')) cpu[name.replace('jungle-', '')] = value;
  }
  return cpu;
}

async function sampleDb(walletIds: string[]): Promise<DbSample> {
  const [row] = await db.em.fork().execute<{ waiters: number; pending: number; lag: number }[]>(
    `select (select count(*)::int from pg_locks where not granted) as waiters,
            (select count(*)::int from outbox_messages where published_at is null) as pending,
            coalesce((select extract(epoch from now() - min(occurred_at)) from outbox_messages where published_at is null), 0)::float8 as lag`,
  );
  void walletIds;
  return { lockWaiters: row?.waiters ?? 0, outboxPending: row?.pending ?? 0, outboxLagSeconds: row?.lag ?? 0 };
}

/** Amostra o banco a cada 250 ms enquanto `work` roda. */
async function withDbSampling<T>(walletIds: string[], work: () => Promise<T>): Promise<{ result: T; samples: DbSample[] }> {
  const samples: DbSample[] = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      samples.push(await sampleDb(walletIds));
      await Bun.sleep(250);
    }
  })();
  const result = await work();
  running = false;
  await sampler;
  return { result, samples };
}

/** Circuito fechado: cada VU envia a próxima requisição ao receber a anterior, até o fim do tempo. */
async function closedLoop(pick: (vu: number) => Wallet, mix: { win: number; replay: number }) {
  const samples: Sample[] = [];
  const deadline = performance.now() + DURATION_S * 1000;
  let replays = 0;
  const cpuProbe = Bun.sleep((DURATION_S * 1000) / 2).then(() => containerCpu());
  await Promise.all(
    Array.from({ length: VUS }, async (_, vu) => {
      let previous: ReturnType<typeof wager> | undefined;
      while (performance.now() < deadline) {
        const replay = previous !== undefined && Math.random() < mix.replay;
        const body = replay && previous !== undefined ? previous : wager(pick(vu), Math.random() < mix.win ? 'WIN' : 'BET', '1.00');
        if (replay) replays += 1;
        const started = performance.now();
        let status = 0;
        try {
          status = (await post('/wagering/transactions', body, `${body.providerId}:${body.externalTransactionId}`)).status;
        } catch {
          status = 0;
        }
        samples.push({ latencyMs: performance.now() - started, status });
        previous = body;
      }
    }),
  );
  return { samples, replays, cpuAtMidRun: await cpuProbe };
}

function summarize(name: string, samples: Sample[], db: DbSample[], extra: Record<string, unknown> = {}) {
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  for (const sample of samples) byStatus[String(sample.status)] = (byStatus[String(sample.status)] ?? 0) + 1;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  const ms = (value: number) => Number(value.toFixed(1));
  return {
    scenario: name,
    durationSeconds: DURATION_S,
    virtualUsers: VUS,
    requests: samples.length,
    throughputRps: Number((samples.length / DURATION_S).toFixed(1)),
    latencyMs: { p50: ms(percentile(latencies, 50)), p95: ms(percentile(latencies, 95)), p99: ms(percentile(latencies, 99)), max: ms(latencies.at(-1) ?? 0) },
    statusCodes: byStatus,
    errorRate: Number((errors / Math.max(1, samples.length)).toFixed(4)),
    rejectedByBusinessRule: byStatus['422'] ?? 0,
    lockWaitersObserved: { max: Math.max(0, ...db.map((s) => s.lockWaiters)), avg: Number((db.reduce((a, s) => a + s.lockWaiters, 0) / Math.max(1, db.length)).toFixed(1)) },
    outbox: {
      maxPending: Math.max(0, ...db.map((s) => s.outboxPending)),
      maxLagSeconds: Number(Math.max(0, ...db.map((s) => s.outboxLagSeconds)).toFixed(2)),
    },
    ...extra,
  };
}

async function invariantViolations(walletIds: string[]): Promise<number> {
  const rows = await db.em.fork().execute(
    `select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = any(?) group by w.id
     having w.balance_minor <> coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0)
         or w.balance_minor < 0`,
    [`{${walletIds.join(',')}}`],
  );
  return rows.length;
}

/** Isola os cenários: o próximo só começa com a outbox do anterior totalmente publicada. */
async function waitOutboxDrained(timeoutMs = 300_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if ((await sampleDb([])).outboxPending === 0) return (performance.now() - started) / 1000;
    await Bun.sleep(250);
  }
  return Number.NaN;
}

function replicas(): number | string {
  const result = Bun.spawnSync(['docker', 'compose', 'ps', '-q', 'app']);
  return result.success ? result.stdout.toString().trim().split('\n').filter(Boolean).length : 'unknown';
}

// ------------------------------------------------------------------ scenarios

const ready = await fetch(`${API}/health/ready`).catch(() => undefined);
if (ready?.status !== 200) {
  console.error(`API não está pronta em ${API}. Suba o ambiente: docker compose up -d --wait [--scale app=3]`);
  process.exit(1);
}

const environment = {
  label: LABEL,
  date: new Date().toISOString(),
  host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3), platform: `${os.platform()} ${os.release()}` },
  appReplicas: replicas(),
  bun: Bun.version,
  target: API,
  durationSeconds: DURATION_S,
  virtualUsers: VUS,
};
console.log(`\n== teste de carga ${run} · ${JSON.stringify(environment)}\n`);

const results: Record<string, unknown>[] = [];

// Aquecimento: conexões, JIT e pools.
const warmup = await createWallets(5, '1000000.00');
await Promise.all(Array.from({ length: 50 }, (_, i) => post('/wagering/transactions', wager(warmup[i % 5]!, 'BET', '1.00'), `w-${run}-${i}`)));

// 1. Distribuído: VUs espalhados por muitas wallets (escala com o número de wallets).
const distributedWallets = await createWallets(WALLETS, '1000000.00');
{
  const { result, samples } = await withDbSampling(distributedWallets.map((w) => w.walletId), () =>
    closedLoop(() => distributedWallets[Math.floor(Math.random() * distributedWallets.length)]!, { win: 0.2, replay: 0.05 }),
  );
  const drained = await waitOutboxDrained();
  results.push(summarize('distributed', result.samples, samples, { wallets: WALLETS, replaysSent: result.replays, outboxDrainSecondsAfterRun: Number(drained.toFixed(2)), cpuAtMidRun: result.cpuAtMidRun }));
}

// 2. Hot wallet: todos os VUs na mesma wallet (o lock por wallet serializa por desenho).
const [hot] = await createWallets(1, '1000000.00');
{
  const { result, samples } = await withDbSampling([hot!.walletId], () => closedLoop(() => hot!, { win: 0.2, replay: 0.05 }));
  const drained = await waitOutboxDrained();
  results.push(summarize('hot-wallet', result.samples, samples, { wallets: 1, replaysSent: result.replays, outboxDrainSecondsAfterRun: Number(drained.toFixed(2)), cpuAtMidRun: result.cpuAtMidRun }));
}

// 3. Ingestão via SQS: tempo até o consumer processar um lote (MiniStack: sem throttling real).
const sqsWallets = await createWallets(50, '1000000.00');
await waitOutboxDrained();
{
  const queueUrl = await resolveQueueUrl(sqs, process.env['SQS_WAGER_QUEUE'] ?? 'wager-transactions.fifo');
  const enqueueStarted = performance.now();
  for (let start = 0; start < SQS_MESSAGES; start += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Array.from({ length: Math.min(10, SQS_MESSAGES - start) }, (_, i) => {
          const wallet = sqsWallets[(start + i) % sqsWallets.length]!;
          const data = wager(wallet, 'BET', '1.00');
          return {
            Id: `m${i}`,
            MessageGroupId: wallet.walletId,
            MessageDeduplicationId: randomUUID(),
            MessageBody: JSON.stringify({
              messageId: `load-${run}-${start + i}`,
              type: 'WagerTransactionRequested',
              occurredAt: new Date().toISOString(),
              data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
            }),
          };
        }),
      }),
    );
  }
  const enqueueSeconds = (performance.now() - enqueueStarted) / 1000;
  const { result: processedSeconds, samples } = await withDbSampling(sqsWallets.map((w) => w.walletId), async () => {
    const started = performance.now();
    while (performance.now() - started < 180_000) {
      const [row] = await db.em.fork().execute<{ n: number }[]>(
        `select count(*)::int as n from wager_transactions where wallet_id = any(?) and kind = 'BET'`,
        [`{${sqsWallets.map((w) => w.walletId).join(',')}}`],
      );
      if ((row?.n ?? 0) >= SQS_MESSAGES) return (performance.now() - started) / 1000 + enqueueSeconds;
      await Bun.sleep(200);
    }
    return Number.NaN;
  });
  results.push({
    scenario: 'sqs-ingestion',
    messages: SQS_MESSAGES,
    wallets: sqsWallets.length,
    enqueueSeconds: Number(enqueueSeconds.toFixed(2)),
    endToEndSeconds: Number(processedSeconds.toFixed(2)),
    throughputMessagesPerSecond: Number((SQS_MESSAGES / processedSeconds).toFixed(1)),
    lockWaitersObserved: { max: Math.max(0, ...samples.map((s) => s.lockWaiters)) },
    outbox: { maxPending: Math.max(0, ...samples.map((s) => s.outboxPending)), maxLagSeconds: Number(Math.max(0, ...samples.map((s) => s.outboxLagSeconds)).toFixed(2)) },
    caveat: 'MiniStack não aplica quotas nem throttling do SQS real: o número reflete o processamento da aplicação, não a fila.',
  });
}

// Correção depois da carga: nenhum número vale sem isso.
const touched = [...warmup, ...distributedWallets, hot!, ...sqsWallets].map((w) => w.walletId);
const violations = await invariantViolations(touched);
const report = { environment, results, correctness: { walletsChecked: touched.length, invariantViolations: violations } };

mkdirSync('docs/load-test', { recursive: true });
const file = `docs/load-test/${LABEL}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

for (const result of results) console.log(JSON.stringify(result));
console.log(`\ninvariante: ${violations === 0 ? 'OK' : `VIOLADO em ${violations} wallets`} (${touched.length} wallets conferidas)`);
console.log(`resultado salvo em ${file}\n`);

sqs.destroy();
await db.close(true);
process.exit(violations === 0 ? 0 : 1);
