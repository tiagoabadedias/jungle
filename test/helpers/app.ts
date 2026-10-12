import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module.ts';
import { configureApp } from '../../src/configure-app.ts';
import { assertLedgerInvariant, connectApp, connectOwner, migrateUp } from './database.ts';
import { HttpClient } from './http-client.ts';

export { type HttpResult, type SubmitBody, wager, type WagerPayload } from './http-client.ts';

/**
 * App NestJS real (mesmo AppModule do `main.ts`) escutando numa porta efêmera, contra o
 * PostgreSQL de testes. Requisições via `fetch`: concorrência de verdade no servidor e no pool.
 */
export class TestApp extends HttpClient {
  private constructor(
    readonly app: INestApplication,
    baseUrl: string,
    /** Conexão de verificação (role da aplicação) para asserts diretos no banco. */
    readonly db: MikroORM,
  ) {
    super(baseUrl);
  }

  /** `env` sobrescreve variáveis só durante o boot (a config é lida na criação do módulo). */
  static async start(env: Record<string, string> = {}): Promise<TestApp> {
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      return await TestApp.boot();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  private static async boot(): Promise<TestApp> {
    const owner = await connectOwner();
    await migrateUp(owner);
    await owner.close(true);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = configureApp(moduleRef.createNestApplication({ logger: ['error'] }));
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    return new TestApp(app, url.replace('[::1]', '127.0.0.1'), await connectApp());
  }

  async stop(): Promise<void> {
    await this.db.close(true);
    await this.app.close();
  }

  /** Invariante final (§13): wallet.balance == saldo reconstruído pelo ledger; version == 1 + movimentos. */
  assertLedgerConsistency(walletId: string): Promise<void> {
    return assertLedgerInvariant(this.db, [walletId]);
  }
}
