import { requireEnv } from '../config/app-config.ts';
import { createOrmConfig } from './mikro-orm.config.ts';

/**
 * Configuração exclusiva da CLI do MikroORM (`bun run orm ...`): migrations rodam como dona
 * das tabelas. Fica separada para que a aplicação não exija DATABASE_MIGRATION_URL ao importar
 * a configuração (bug encontrado ao subir a app em container).
 */
export default createOrmConfig({ clientUrl: requireEnv('DATABASE_MIGRATION_URL') });
