import { expect } from 'bun:test';
import { DriverException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../../src/shared/infrastructure/config/app-config.ts';
import { createOrmConfig, type OrmConfigProps } from '../../src/shared/infrastructure/database/mikro-orm.config.ts';

/**
 * Conexões reais com o PostgreSQL de testes (`.env.test` → banco `wagering_test`):
 *  - owner: dona das tabelas, roda migrations;
 *  - app:   role da aplicação (wagering_app), a mesma identidade que a API usa.
 */
const TEST_DATABASE = 'wagering_test';

export async function connectOwner(): Promise<MikroORM> {
  return connectToTestDatabase(requireEnv('DATABASE_MIGRATION_URL'), 2);
}

/** Role da aplicação; `entities` quando o teste usa os repositórios (UnitOfWork). */
export async function connectApp(options: { poolMax?: number; entities?: OrmConfigProps['entities'] } = {}): Promise<MikroORM> {
  return connectToTestDatabase(requireEnv('DATABASE_URL'), options.poolMax ?? 5, options.entities);
}

/**
 * Variáveis exportadas no shell têm precedência sobre o `.env.test`. Como os testes de
 * migration derrubam todas as tabelas, recusamos qualquer banco que não seja o de testes.
 */
async function connectToTestDatabase(clientUrl: string, poolMax: number, entities?: OrmConfigProps['entities']): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig({ clientUrl, poolMax, ...(entities === undefined ? {} : { entities }) }));
  const [row] = await orm.em.fork().execute<{ database: string }[]>('select current_database() as database');
  if (row?.database !== TEST_DATABASE) {
    await orm.close(true);
    throw new Error(`refusing to run tests against database "${row?.database}"; expected "${TEST_DATABASE}"`);
  }
  return orm;
}

export async function migrateUp(owner: MikroORM): Promise<void> {
  await owner.migrator.up();
}

export type SqlParam = string | number | bigint | boolean | null | Date;
export type Row = Record<string, SqlParam>;

export async function execute<T extends object = Row>(orm: MikroORM, sql: string, params: SqlParam[] = []): Promise<T[]> {
  return orm.em.fork().execute<T[]>(sql, params);
}

export async function insert(orm: MikroORM, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  await execute(orm, `insert into ${table} (${columns.join(', ')}) values (${placeholders})`, Object.values(row));
}

/**
 * Invariante final (§13) para um conjunto de wallets, numa consulta só:
 * `wallet.balance == saldo reconstruído pelo ledger`, `version == 1 + movimentos` e saldo ≥ 0.
 * Só as wallets informadas: testes de constraints inserem linhas inconsistentes de propósito.
 */
export async function assertLedgerInvariant(orm: MikroORM, walletIds: readonly string[]): Promise<void> {
  if (walletIds.length === 0) return;
  const rows = await execute<{ id: string; stored: string; calculated: string; version: number; movements: number }>(
    orm,
    `select w.id,
            w.balance_minor::text as stored,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0)::text as calculated,
            w.version,
            count(e.id) filter (where t.kind <> 'OPENING')::int as movements
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
       left join wager_transactions t on t.id = e.transaction_id
      where w.id = any(?::uuid[])
      group by w.id`,
    [`{${walletIds.join(',')}}`],
  );
  expect(rows).toHaveLength(new Set(walletIds).size);
  const broken = rows.filter(
    (row) => row.stored !== row.calculated || row.version !== 1 + row.movements || row.stored.startsWith('-'),
  );
  expect(broken).toEqual([]);
}

/**
 * Trava a wallet (`SELECT … FOR UPDATE`) numa transação à parte e a mantém aberta até a função
 * devolvida ser chamada: simula outra instância segurando o lock (lock_timeout → 503 / retry).
 */
export async function holdWalletLock(orm: MikroORM, walletId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => (signalLocked = resolve));
  const holder = orm.em.fork().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [walletId]);
    signalLocked();
    await held;
  });
  await locked;
  return async () => {
    release();
    await holder;
  };
}

/** Resolve com a exceção do driver (ou falha o teste se a operação passou). */
export async function captureDriverError(operation: Promise<unknown>): Promise<DriverException> {
  const outcome = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(DriverException);
  return outcome as DriverException;
}

/** Afirma que a operação violou uma regra do banco: SQLSTATE e, quando houver, o nome da constraint/trigger. */
export async function expectViolation(operation: Promise<unknown>, sqlState: string, name?: string): Promise<void> {
  const error = await captureDriverError(operation);
  expect(error.code).toBe(sqlState);
  if (name !== undefined) expect(error.message).toContain(name);
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  restrictViolation: '23001',
  insufficientPrivilege: '42501',
} as const;
