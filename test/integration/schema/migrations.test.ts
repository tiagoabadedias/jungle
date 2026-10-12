import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectOwner, execute } from '../../helpers/database.ts';

const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

let owner: MikroORM;

beforeAll(async () => {
  owner = await connectOwner();
});

afterAll(async () => {
  await owner.migrator.up(); // deixa o banco migrado para os demais arquivos
  await owner.close(true);
});

async function existingTables(): Promise<string[]> {
  const rows = await execute<{ table_name: string }>(
    owner,
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any(?) order by table_name`,
    [`{${TABLES.join(',')}}`],
  );
  return rows.map((row) => row.table_name);
}

describe('migrations versionadas e reversíveis (§4)', () => {
  test('up → down → up', async () => {
    await owner.migrator.up();
    expect(await existingTables()).toEqual(TABLES);

    await owner.migrator.down({ to: 0 });
    expect(await existingTables()).toEqual([]);
    const functions = await execute<{ proname: string }>(
      owner,
      `select proname from pg_proc where proname in ('wager_transactions_guard', 'wallet_ledger_entries_append_only')`,
    );
    expect(functions).toEqual([]);

    await owner.migrator.up();
    expect(await existingTables()).toEqual(TABLES);
  });

  test('triggers de imutabilidade instalados', async () => {
    const triggers = await execute<{ tgname: string }>(
      owner,
      `select tgname from pg_trigger where not tgisinternal order by tgname`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual([
      'wager_transactions_guard_trg',
      'wallet_ledger_entries_no_truncate_trg',
      'wallet_ledger_entries_no_update_delete_trg',
    ]);
  });

  test('dinheiro é bigint em todas as colunas monetárias (nunca numeric/float)', async () => {
    const rows = await execute<{ column_name: string; data_type: string }>(
      owner,
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and column_name like '%_minor' order by table_name, column_name`,
    );
    expect(rows.length).toBe(6);
    for (const row of rows) expect(row.data_type).toBe('bigint');

    const floats = await execute(
      owner,
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type in ('real', 'double precision', 'numeric', 'money')`,
    );
    expect(floats).toEqual([]);
  });
});
