import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectApp, connectOwner, execute, expectViolation, migrateUp, SQLSTATE } from '../../helpers/database.ts';
import { seedProcessedBet } from '../../helpers/rows.ts';

/**
 * A aplicação conecta como wagering_app, que não é dona das tabelas: não consegue desligar
 * os triggers que protegem o ledger, apagar registros nem alterar lançamentos (§5.5, §5.9).
 */
let owner: MikroORM;
let app: MikroORM;

beforeAll(async () => {
  owner = await connectOwner();
  await migrateUp(owner);
  app = await connectApp();
});

afterAll(async () => {
  await app.close(true);
  await owner.close(true);
});

describe('privilégios da role da aplicação', () => {
  test('conecta como wagering_app, que não é superusuário', async () => {
    const [row] = await execute<{ current_user: string; rolsuper: boolean }>(
      app,
      'select current_user, rolsuper from pg_roles where rolname = current_user',
    );
    expect(row).toEqual({ current_user: 'wagering_app', rolsuper: false });
  });

  test('não consegue desligar os triggers do ledger (precisa ser dona)', async () => {
    await expectViolation(
      execute(app, 'alter table wallet_ledger_entries disable trigger wallet_ledger_entries_no_update_delete_trg'),
      SQLSTATE.insufficientPrivilege,
    );
  });

  test('sem UPDATE no ledger e sem DELETE em nenhuma tabela', async () => {
    const { entry, walletId } = await seedProcessedBet(app);
    await expectViolation(
      execute(app, 'update wallet_ledger_entries set amount_minor = 1 where id = ?', [String(entry['id'])]),
      SQLSTATE.insufficientPrivilege,
    );
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']) {
      await expectViolation(execute(app, `delete from ${table} where false`), SQLSTATE.insufficientPrivilege);
    }
    await expectViolation(execute(app, 'truncate wallets cascade'), SQLSTATE.insufficientPrivilege);
    const rows = await execute(app, 'select 1 from wallets where id = ?', [walletId]);
    expect(rows).toHaveLength(1);
  });

  test('não altera o schema', async () => {
    await expectViolation(execute(app, 'alter table wallets drop constraint wallets_balance_non_negative_ck'), SQLSTATE.insufficientPrivilege);
  });
});
