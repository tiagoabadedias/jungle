import { ConnectionException, DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../../../messaging/infrastructure/persistence/inbox-persistence.ts';
import { MikroOrmOutboxRepository } from '../../../messaging/infrastructure/persistence/outbox-persistence.ts';
import { MikroOrmWagerTransactionRepository } from '../../../wagering/infrastructure/persistence/wager-transaction-persistence.ts';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../wallet/infrastructure/persistence/wallet-persistence.ts';
import { type DuplicateIdentity, TransientInfrastructureError, UniqueViolationError } from '../../application/application-error.ts';
import type { TransactionScope, UnitOfWork } from '../../application/ports/unit-of-work.ts';

export interface UnitOfWorkOptions {
  /** Tempo máximo de espera por um lock de linha antes de desistir (→ 503). */
  lockTimeoutMs: number;
  /** Chamado quando o banco recusa por lock não obtido a tempo (55P03) ou deadlock (40P01). */
  onLockConflict?: ((sqlState: string) => void) | undefined;
}

const LOCK_CONFLICT_SQLSTATES = new Set(['55P03', '40P01']);

/** Constraints do schema que representam identidades de negócio (ver migration inicial). */
const DUPLICATE_IDENTITY_BY_CONSTRAINT: Readonly<Record<string, DuplicateIdentity>> = {
  wager_transactions_idempotency_key_uq: 'WAGER_TRANSACTION',
  wager_transactions_provider_external_uq: 'WAGER_TRANSACTION',
  wallets_player_currency_uq: 'WALLET',
};

/**
 * SQLSTATEs em que reenviar a mesma requisição pode dar certo: lock não obtido a tempo
 * (55P03) e deadlock/serialização (40P01, 40001), mais as classes inteiras de falha de
 * conexão (08), recursos insuficientes (53), intervenção do operador — statement cancelado,
 * servidor reiniciando (57) — e erro de sistema/E/S (58). Classificar uma queda de conexão
 * como permanente marcaria uma transação como FAILED por engano.
 */
const TRANSIENT_SQLSTATES = new Set(['55P03', '40P01', '40001']);
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53', '57', '58'];
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
/** Mensagens do `pg` sem código: conexão derrubada no meio da consulta ou fechada pelo servidor. */
const TRANSIENT_CONNECTION_MESSAGES = ['Connection terminated', 'connection terminated', 'Client has encountered a connection error'];

/**
 * Cada `run` é um EntityManager novo (fork) numa transação SQL própria, em READ COMMITTED:
 * com `SELECT … FOR UPDATE` na wallet, a segunda transação espera o commit da primeira e
 * relê a linha já atualizada — sem lost update e sem retry de serialização.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;
  private readonly onLockConflict: ((sqlState: string) => void) | undefined;

  constructor(
    private readonly orm: MikroORM,
    options: UnitOfWorkOptions,
  ) {
    if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.onLockConflict = options.onLockConflict;
  }

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        return work(createScope(em));
      });
    } catch (error) {
      if (error instanceof DriverException && error.code !== undefined && LOCK_CONFLICT_SQLSTATES.has(error.code)) {
        this.onLockConflict?.(error.code);
      }
      throw translateError(error);
    }
  }
}

export function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

export function translateError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = constraintName(error) ?? 'unknown';
    return new UniqueViolationError(constraint, DUPLICATE_IDENTITY_BY_CONSTRAINT[constraint], error);
  }
  if (error instanceof ConnectionException) {
    return new TransientInfrastructureError('database unavailable', error);
  }
  if (error instanceof DriverException && error.code !== undefined && isTransientSqlState(error.code)) {
    return new TransientInfrastructureError(`database temporarily unavailable (${error.code})`, error);
  }
  // pg.Pool esgotado: nenhuma conexão livre dentro de connectionTimeoutMillis.
  if (error instanceof Error && error.message.includes('timeout exceeded when trying to connect')) {
    return new TransientInfrastructureError('database connection pool exhausted', error);
  }
  if (error instanceof Error && TRANSIENT_CONNECTION_MESSAGES.some((text) => error.message.includes(text))) {
    return new TransientInfrastructureError('database connection lost', error);
  }
  if (isNetworkError(error)) {
    return new TransientInfrastructureError('database unreachable', error);
  }
  return error;
}

function isTransientSqlState(code: string): boolean {
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SQLSTATE_CLASSES.some((sqlClass) => code.startsWith(sqlClass));
}

function constraintName(error: DriverException): string | undefined {
  const fromDriver = (error as DriverException & { constraint?: unknown }).constraint;
  if (typeof fromDriver === 'string') return fromDriver;
  return /constraint "([^"]+)"/.exec(error.message)?.[1];
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}
