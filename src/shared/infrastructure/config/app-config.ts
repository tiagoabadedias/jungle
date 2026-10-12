import { ExponentialBackoff } from '../../domain/exponential-backoff.ts';

export const FAULT_AFTER_COMMIT_BEFORE_ACK = 'after_commit_before_ack';

/** Padrões do pool, únicos para a app e para as ferramentas (migrations, CLI, testes, carga). */
export const DATABASE_POOL_MAX_DEFAULT = 10;
export const DATABASE_CONNECTION_TIMEOUT_MS_DEFAULT = 5_000;

export interface SqsConfig {
  /** Endpoint do emulador (MiniStack/LocalStack); ausente = AWS real. */
  endpoint: string | undefined;
  region: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
}

export interface ConsumerConfig {
  enabled: boolean;
  consumerName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  /** Tentativas antes da DLQ (a RedrivePolicy da fila é a rede de segurança). */
  maxAttempts: number;
  visibilityBackoff: ExponentialBackoff;
  /** No SIGTERM: espera máxima pelo in-flight antes de devolver a visibilidade. */
  drainTimeoutMs: number;
  /** Só para testes de crash (§13 conc. 5): mata o processo depois do commit e antes do ack. */
  faultInjection: typeof FAULT_AFTER_COMMIT_BEFORE_ACK | undefined;
}

export interface PollingConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  /** Espera máxima por uma conexão do pool antes de responder 503. */
  databaseConnectionTimeoutMs: number;
  /** Espera máxima por lock de wallet antes de responder 503. */
  lockTimeoutMs: number;
  /** §7.1: limite de tentativas e backoff para referências fora de ordem (formato da `ReferenceRetryPolicy`). */
  referenceRetry: { maxAttempts: number; backoff: ExponentialBackoff };
  sqs: SqsConfig;
  consumer: ConsumerConfig;
  outboxPublisher: PollingConfig & { backoff: ExponentialBackoff };
  pendingReferences: PollingConfig;
}

export const APP_CONFIG = Symbol('AppConfig');

type Env = Record<string, string | undefined>;

/** Lê e valida o ambiente no boot: configuração inválida derruba o processo antes de aceitar tráfego. */
export function loadAppConfig(env: Env = process.env): AppConfig {
  const fault = optional(env, 'FAULT_INJECTION');
  if (fault !== undefined && fault !== FAULT_AFTER_COMMIT_BEFORE_ACK) {
    throw new Error(`FAULT_INJECTION must be "${FAULT_AFTER_COMMIT_BEFORE_ACK}" when set`);
  }
  if (fault !== undefined && env['NODE_ENV'] === 'production') {
    throw new Error('FAULT_INJECTION is a test-only switch and is refused in production');
  }
  return {
    port: integer(env, 'PORT', 3000),
    logLevel: logLevel(env),
    databaseUrl: required(env, 'DATABASE_URL'),
    databasePoolMax: integer(env, 'DATABASE_POOL_MAX', DATABASE_POOL_MAX_DEFAULT),
    databaseConnectionTimeoutMs: integer(env, 'DATABASE_CONNECTION_TIMEOUT_MS', DATABASE_CONNECTION_TIMEOUT_MS_DEFAULT),
    lockTimeoutMs: integer(env, 'LOCK_TIMEOUT_MS', 5_000),
    referenceRetry: {
      maxAttempts: integer(env, 'REFERENCE_RETRY_MAX_ATTEMPTS', 10),
      backoff: ExponentialBackoff.create({
        baseDelayMs: integer(env, 'REFERENCE_RETRY_BASE_DELAY_MS', 2_000),
        maxDelayMs: integer(env, 'REFERENCE_RETRY_MAX_DELAY_MS', 300_000),
      }),
    },
    sqs: {
      endpoint: optional(env, 'SQS_ENDPOINT'),
      region: optional(env, 'AWS_REGION') ?? 'us-east-1',
      wagerQueueName: optional(env, 'SQS_WAGER_QUEUE') ?? 'wager-transactions.fifo',
      wagerDlqName: optional(env, 'SQS_WAGER_DLQ') ?? 'wager-transactions-dlq.fifo',
      eventsQueueName: optional(env, 'SQS_EVENTS_QUEUE') ?? 'wallet-events.fifo',
    },
    consumer: {
      enabled: boolean(env, 'SQS_CONSUMER_ENABLED', true),
      consumerName: optional(env, 'SQS_CONSUMER_NAME') ?? 'wager-transactions-consumer',
      waitTimeSeconds: integerInRange(env, 'SQS_WAIT_TIME_SECONDS', 20, 20), // limites do ReceiveMessage
      maxMessages: integerInRange(env, 'SQS_MAX_MESSAGES', 10, 10),
      maxAttempts: integer(env, 'SQS_MAX_ATTEMPTS', 5),
      visibilityBackoff: ExponentialBackoff.create({
        baseDelayMs: integer(env, 'SQS_RETRY_BASE_DELAY_MS', 5_000),
        maxDelayMs: integer(env, 'SQS_RETRY_MAX_DELAY_MS', 300_000),
      }),
      drainTimeoutMs: integer(env, 'SQS_DRAIN_TIMEOUT_MS', 20_000),
      faultInjection: fault === undefined ? undefined : FAULT_AFTER_COMMIT_BEFORE_ACK,
    },
    outboxPublisher: {
      enabled: boolean(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: integer(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: integer(env, 'OUTBOX_BATCH_SIZE', 50),
      backoff: ExponentialBackoff.create({
        baseDelayMs: integer(env, 'OUTBOX_RETRY_BASE_DELAY_MS', 1_000),
        maxDelayMs: integer(env, 'OUTBOX_RETRY_MAX_DELAY_MS', 60_000),
      }),
    },
    pendingReferences: {
      enabled: boolean(env, 'PENDING_REFERENCE_WORKER_ENABLED', true),
      pollIntervalMs: integer(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
      batchSize: integer(env, 'PENDING_REFERENCE_BATCH_SIZE', 50),
    },
  };
}

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function logLevel(env: Env): string {
  const value = optional(env, 'LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.has(value)) throw new Error(`environment variable LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new Error(`environment variable ${name} is required`);
  return value;
}

/** Variável obrigatória para ferramentas fora do boot da app (migrations, CLI, testes, scripts). */
export function requireEnv(name: string, env: Env = process.env): string {
  return required(env, name);
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`environment variable ${name} must be "true" or "false"`);
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  return parsePositiveInteger(raw, `environment variable ${name}`);
}

function integerInRange(env: Env, name: string, fallback: number, max: number): number {
  const value = integer(env, name, fallback);
  if (value > max) throw new Error(`environment variable ${name} must be between 1 and ${max}`);
  return value;
}

/** Inteiro positivo estrito (contadores, tempos). Não usar para dinheiro. */
export function parsePositiveInteger(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a positive integer`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
