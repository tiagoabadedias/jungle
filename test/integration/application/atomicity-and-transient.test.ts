import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../../src/shared/application/application-error.ts';
import type { TransactionScope, UnitOfWork } from '../../../src/shared/application/ports/unit-of-work.ts';
import { ExponentialBackoff } from '../../../src/shared/domain/exponential-backoff.ts';
import { ENTITY_SCHEMAS } from '../../../src/shared/infrastructure/database/entities.ts';
import { MikroOrmUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-unit-of-work.ts';
import { SystemClock, UuidV7Generator } from '../../../src/shared/infrastructure/system-providers.ts';
import { ProcessWagerTransactionUseCase } from '../../../src/wagering/application/process-wager-transaction.use-case.ts';
import { CreateWalletUseCase } from '../../../src/wallet/application/create-wallet.use-case.ts';
import { assertLedgerInvariant, connectApp, connectOwner, execute, holdWalletLock, migrateUp } from '../../helpers/database.ts';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
const clock = new SystemClock();
const ids = new UuidV7Generator();
const referenceRetry = { maxAttempts: 10, backoff: ExponentialBackoff.create({ baseDelayMs: 2_000, maxDelayMs: 300_000 }) };

beforeAll(async () => {
  const owner = await connectOwner();
  await migrateUp(owner);
  await owner.close(true);
  orm = await connectApp({ entities: ENTITY_SCHEMAS, poolMax: 5 });
  uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 5_000 });
});

afterAll(async () => {
  await orm.close(true);
});

// Invariante final (§13): wallet.balance == saldo reconstruído pelo ledger, inclusive depois das falhas simuladas.
const createdWallets: string[] = [];
afterEach(async () => {
  await assertLedgerInvariant(orm, createdWallets.splice(0));
});

/** UnitOfWork real cujo último passo (outbox) falha: tudo o que veio antes precisa sumir. */
class FailingOutboxUnitOfWork implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.inner.run((scope) =>
      work({
        ...scope,
        outbox: {
          claimDue: (now, limit) => scope.outbox.claimDue(now, limit),
          saveDelivery: (message) => scope.outbox.saveDelivery(message),
          insert: async () => {
            throw new Error('simulated crash while writing the outbox');
          },
        },
      }),
    );
  }
}

async function newWallet(amount: string) {
  const playerId = randomUUID();
  const view = await new CreateWalletUseCase(uow, clock, ids).execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    context: { correlationId: 'test' },
  });
  createdWallets.push(view.id);
  return { walletId: view.id, playerId };
}

function betCommand(wallet: { walletId: string; playerId: string }, amount: string) {
  const externalTransactionId = `bet-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    context: { correlationId: 'test' },
  };
}

describe('atomicidade: wallet, transação, ledger e outbox na mesma transação SQL (§6.5, §11)', () => {
  test('falha ao gravar a outbox desfaz débito, lançamento e transação', async () => {
    const wallet = await newWallet('100.00');
    const failing = new ProcessWagerTransactionUseCase(new FailingOutboxUnitOfWork(uow), clock, ids, referenceRetry);
    const command = betCommand(wallet, '40.00');

    await expect(failing.execute(command)).rejects.toThrow('simulated crash while writing the outbox');

    const [state] = await execute<{ balance: string; version: number; transactions: number; entries: number; events: number }>(
      orm,
      `select w.balance_minor::text as balance, w.version,
              (select count(*)::int from wager_transactions t where t.wallet_id = w.id and t.kind <> 'OPENING') as transactions,
              (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id) as entries,
              (select count(*)::int from outbox_messages o where o.aggregate_id = w.id) as events
         from wallets w where w.id = ?`,
      [wallet.walletId],
    );
    expect(state).toEqual({ balance: '10000', version: 1, transactions: 0, entries: 1, events: 2 }); // só o OPENING

    // O retry do provedor, já sem a falha, processa normalmente e uma única vez.
    const healthy = new ProcessWagerTransactionUseCase(uow, clock, ids, referenceRetry);
    const result = await healthy.execute(command);
    expect(result).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '60.00' } });
  });

  test('falha ao criar a wallet não deixa wallet, OPENING nem lançamento', async () => {
    const playerId = randomUUID();
    const failing = new CreateWalletUseCase(new FailingOutboxUnitOfWork(uow), clock, ids);
    await expect(
      failing.execute({ playerId, initialBalance: { amount: '50.00', currency: 'BRL' }, context: { correlationId: 't' } }),
    ).rejects.toThrow('simulated crash');
    const rows = await execute(orm, 'select 1 from wallets where player_id = ?', [playerId]);
    expect(rows).toHaveLength(0);
  });
});

describe('falha transitória: lock não obtido a tempo vira 503, nunca espera indefinida', () => {
  test('wallet travada por outra transação → TransientInfrastructureError após lock_timeout', async () => {
    const wallet = await newWallet('100.00');
    const impatient = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 200 }), clock, ids, referenceRetry);

    const release = await holdWalletLock(orm, wallet.walletId);
    const started = Date.now();
    const outcome = await impatient.execute(betCommand(wallet, '1.00')).then(
      () => undefined,
      (error: unknown) => error,
    );
    await release();

    expect(outcome).toBeInstanceOf(TransientInfrastructureError);
    expect(Date.now() - started).toBeLessThan(3_000);
    const rows = await execute(orm, `select 1 from wager_transactions where wallet_id = ? and kind = 'BET'`, [wallet.walletId]);
    expect(rows).toHaveLength(0);
  });
});
