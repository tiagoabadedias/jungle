import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261010000001InitialSchema } from './Migration20261010000001InitialSchema.ts';

/**
 * Lista explícita (sem glob de arquivos): descoberta por diretório é frágil sob Bun.
 * Toda nova migration é registrada aqui, em ordem.
 */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261010000001InitialSchema', class: Migration20261010000001InitialSchema },
];
