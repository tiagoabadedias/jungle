import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { migrationsList } from '../../migrations/index.ts';

/**
 * As migrations são listadas explicitamente (sem descoberta por diretório, frágil sob Bun).
 * Uma migration criada e não registrada seria ignorada em silêncio: este teste impede isso.
 */
describe('registro de migrations', () => {
  test('todo arquivo migrations/Migration*.ts está em migrationsList, em ordem', async () => {
    const files: string[] = [];
    for await (const file of new Glob('Migration*.ts').scan({ cwd: 'migrations' })) files.push(file.replace(/\.ts$/, ''));
    files.sort();
    expect(migrationsList.map((migration) => migration.name)).toEqual(files);
  });
});
