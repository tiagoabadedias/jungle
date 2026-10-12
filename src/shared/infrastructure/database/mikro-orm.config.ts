import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../../migrations/index.ts';
import { DATABASE_CONNECTION_TIMEOUT_MS_DEFAULT, DATABASE_POOL_MAX_DEFAULT } from '../config/app-config.ts';

export interface OrmConfigProps {
  clientUrl: string;
  entities?: Options['entities'];
  poolMax?: number;
  /** Espera máxima por uma conexão livre do pool (o `lock_timeout` só vale depois disso). */
  connectionTimeoutMs?: number;
}

/**
 * Configuração única do MikroORM 7. Entidades passadas explicitamente (sem glob/ts-morph,
 * frágeis sob Bun). Migrations listadas explicitamente, sem snapshot de schema: o SQL é
 * escrito à mão para preservar triggers, índices parciais e CHECKs.
 */
export function createOrmConfig(props: OrmConfigProps): Options {
  return defineConfig({
    clientUrl: props.clientUrl,
    entities: props.entities ?? [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: './migrations',
      migrationsList,
      snapshot: false,
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
    },
    pool: { min: 0, max: props.poolMax ?? DATABASE_POOL_MAX_DEFAULT },
    // Repassado ao pg.Pool. O padrão do pg (0) espera para sempre por uma conexão livre.
    driverOptions: { connectionTimeoutMillis: props.connectionTimeoutMs ?? DATABASE_CONNECTION_TIMEOUT_MS_DEFAULT },
    forceUtcTimezone: true,
  });
}

