import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work.ts';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { METRICS, type Metrics } from '../observability/metrics.ts';
import { ENTITY_SCHEMAS } from './entities.ts';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.ts';
import { createOrmConfig } from './mikro-orm.config.ts';

/** Fecha o pool no shutdown, depois que os demais módulos terminaram o trabalho em andamento. */
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        MikroORM.init(
          createOrmConfig({
            clientUrl: config.databaseUrl,
            entities: ENTITY_SCHEMAS,
            poolMax: config.databasePoolMax,
            connectionTimeoutMs: config.databaseConnectionTimeoutMs,
          }),
        ),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG, METRICS],
      useFactory: (orm: MikroORM, config: AppConfig, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, {
          lockTimeoutMs: config.lockTimeoutMs,
          onLockConflict: (sqlstate) => metrics.lockConflicts.inc({ sqlstate }),
        }),
    },
    OrmLifecycle,
  ],
  exports: [MikroORM, UNIT_OF_WORK],
})
export class DatabaseModule {}
