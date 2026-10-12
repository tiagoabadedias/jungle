import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../config/app-config.ts';
import { createOrmConfig } from './mikro-orm.config.ts';

/**
 * Executa migrations de forma programática (sem a CLI e sem depender de `.env`):
 * funciona igual no host, no container e no CI. Usa a role dona das tabelas.
 *
 *   bun src/shared/infrastructure/database/migrate.ts up
 *   bun src/shared/infrastructure/database/migrate.ts down   # reverte tudo
 */
const direction = process.argv[2] ?? 'up';
if (direction !== 'up' && direction !== 'down') {
  console.error(`usage: migrate.ts [up|down] (received "${direction}")`);
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig({ clientUrl: requireEnv('DATABASE_MIGRATION_URL'), poolMax: 1 }));
try {
  const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
  console.log(JSON.stringify({ level: 'info', msg: `migrations ${direction}`, migrations: executed.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
