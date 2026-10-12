# MikroORM — guia de boas práticas (NestJS + PostgreSQL + Bun)

> Conferido em **2026-10-10** contra o **MikroORM 7.2.5** (npm `latest`, publicado em 2026-10-09).
> Fontes: docs oficiais (`mikro-orm.io/docs`), código publicado dos pacotes 7.2.5 e issues do GitHub.
> Os snippets mostram a API com nomes genéricos (`Account`, `Order`). **Não são código do projeto.**
> `> RISCO` marca pontos que já causaram bug ou que a doc não cobre. Os itens com "verificar no spike" vão para a Fase 0 do PLAN.

---

## 1. Versão, pacotes e configuração

- A versão estável atual é a **v7** (`7.2.5`). A v6 continua em manutenção (`latest-v6` = 6.6.17). Este guia trata só da v7. Upgrade: [upgrading-v6-to-v7](https://mikro-orm.io/docs/upgrading-v6-to-v7).
- A v7 é **ESM nativo** e trocou o **knex pelo Kysely**. O `@mikro-orm/knex` passou a se chamar `@mikro-orm/sql`, e `em.getKnex()` virou `em.getKysely()`. **Não instale `@mikro-orm/knex`**, que só existe na v6.
- O `engines` declara `node >= 22.17`. Bun não aparece no `engines`; veja a seção 10.

| Pacote | Para quê |
|---|---|
| `@mikro-orm/core` | EM, UoW, `LockMode`, exceptions, `EntitySchema` |
| `@mikro-orm/postgresql` | driver; traz `@mikro-orm/sql`, `kysely` e `pg` |
| `@mikro-orm/migrations` | `Migrator` (a v7 não usa mais umzug) |
| `@mikro-orm/nestjs` (7.1.0) | `MikroOrmModule`; peer: Nest `^11 \|\| ^12`, `reflect-metadata` |
| `@mikro-orm/decorators` | `@CreateRequestContext`, `@EnsureRequestContext` e `@Transactional`, todos em `/legacy` |
| `@mikro-orm/cli` | CLI `mikro-orm`. Opcional se as migrations rodarem só de forma programática |
| `@mikro-orm/reflection` | **não usar**. É o TsMorph, desnecessário com `EntitySchema` e frágil no Bun (seção 10) |

- **reflect-metadata:** desde a v7 o `ReflectMetadataProvider` deixou de ser o padrão ([#reflectmetadataprovider-no-longer-the-default](https://mikro-orm.io/docs/upgrading-v6-to-v7#reflectmetadataprovider-no-longer-the-default)). O padrão agora é o `MetadataProvider` base, que lê só o que está declarado. Com `EntitySchema` o ORM **não precisa** de reflect-metadata. O NestJS, porém, precisa dele de qualquer forma.
- **Discovery:** passe as instâncias de `EntitySchema` explicitamente em `entities: [...]`. Evite glob ou pasta, porque isso exige `entitiesTs` e acesso ao fs, o que é frágil no Bun e em bundles.

```ts
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: [AccountSchema, OrderSchema],          // instâncias, sem glob
  extensions: [Migrator],
  pool: { min: 2, max: 10, idleTimeoutMillis: 30_000 },
  migrations: { path: './migrations', transactional: true, allOrNothing: true },
  debug: process.env.NODE_ENV !== 'production' ? ['query'] : false,
});
```

- Outros comportamentos da v7: a conexão é **sempre lazy** (a opção `connect` foi removida), o `.env` **não** é mais carregado automaticamente (importe `dotenv/config` se precisar; o Bun já lê `.env` sozinho) e `allowGlobalContext` continua `false`. Ver [configuration](https://mikro-orm.io/docs/configuration).

## 2. EntitySchema sem decorators

- A doc atual recomenda `defineEntity` ([define-entity](https://mikro-orm.io/docs/define-entity)). `new EntitySchema({ class, properties })` continua suportado e é a forma direta para mapear uma classe que já existe, como um *record* simples.
- Mapeamentos (conferidos no código do driver PG):

| Coluna | Propriedade |
|---|---|
| `numeric(19,2)` → **string** | `{ type: 'decimal', precision: 19, scale: 2, runtimeType: 'string' }` |
| `char(3)` | `{ type: 'character', length: 3 }` |
| `uuid` | `{ type: 'uuid', primary: true }` |
| enum | `{ enum: true, items: () => Kind }`. `nativeEnumName: 'kind'` gera um tipo nativo do PG. Para enum em `text` + `CHECK`, omita o `nativeEnumName` |
| `jsonb` | `{ type: 'json' }` (no PG o `getJsonDeclarationSQL()` retorna `jsonb`) |
| `timestamptz(6)` | `{ type: 'datetime' }` (no PG o padrão é `timestamptz`; `forceUtcTimezone` vem `true` na v7) |
| optimistic lock | `{ type: 'integer', version: true }` |

```ts
export const AccountSchema = new EntitySchema<AccountRecord>({
  class: AccountRecord, tableName: 'accounts',
  properties: {
    id:       { type: 'uuid', primary: true },
    balance:  { type: 'decimal', precision: 19, scale: 2, runtimeType: 'string' },
    currency: { type: 'character', length: 3 },
    version:  { type: 'integer', version: true },
    meta:     { type: 'json', nullable: true },
    createdAt:{ type: 'datetime' },
  },
});
```

- **Dinheiro:** o `DecimalType.convertToJSValue` devolve `String(value)`, a não ser que `mode`/`runtimeType` seja `'number'`. O `pg` já entrega `numeric` como string, inclusive em SQL raw. O `compareValues` normaliza a escala (`"100.0"` == `"100.00"`), então não gera UPDATE à toa.
- O `pg` do MikroORM mantém `date`/`timestamp`/`timestamptz` como **string crua** no parser, e a conversão para `Date` acontece no `DateTimeType`. Em SQL raw (`em.execute`), datas voltam como **string**.

> **RISCO — `runtimeType` esquecido.** Sem `runtimeType: 'string'`, o TS do *record* aceita `number` e alguém pode escrever `Number(balance)` no mapper. O mapper deve receber `string` e chamar `Money.from(str)` direto.

## 3. EntitySchema sobre a classe de domínio vs *records* separados

| | Schema direto na classe de domínio | *Record* + mapper (`rehydrate`) — **adotado** |
|---|---|---|
| Hidratação | `Object.create(Class.prototype)` + atribuição de campos (EntityFactory). **O construtor não roda**, então as invariantes não são checadas | O mapper chama `Domain.rehydrate(state)`, então as invariantes rodam |
| Construtor privado | A v7 **não aceita** ([#private-constructors-no-longer-allowed-with-defineentityentityschema](https://mikro-orm.io/docs/upgrading-v6-to-v7#private-constructors-no-longer-allowed-with-defineentityentityschema)). A saída é `class: Domain as any` | sem problema |
| Campos `#private` | Quebram o `Object.create`. Exigem `forceEntityConstructor`, que **chama o construtor**, e um construtor privado com parâmetros entra em conflito com isso | sem problema |
| `Money`/VO | Precisa de um `Type` customizado ou de embeddable, e o ORM passa a conhecer o domínio | O VO fica só no domínio; a coluna é string |
| Dirty-checking / UoW | automático | O repositório precisa aplicar o estado: `em.assign(record, …)` ou update explícito |
| Boilerplate | menor | mapper + record por agregado |

- Conclusão: para um domínio DDD puro, com construtor privado, `rehydrate` e VOs, o par **record + mapper** é o que funciona com a v7 sem gambiarra. O custo é que o repositório vira o responsável por levar o estado do agregado para o record gerenciado (ou por emitir UPDATE explícito com `version`).
- Docs: [configuration — forceEntityConstructor](https://mikro-orm.io/docs/configuration).

> **RISCO — identity map.** Se o repositório faz `findOne` do record, mapeia para o domínio e depois cria **outro** record com o mesmo PK para persistir, o UoW reclama de entidade duplicada no identity map. Atualize o record gerenciado (`em.assign`) ou use `em.nativeUpdate`/QB.

## 4. Transações, fork e RequestContext

- `em.transactional(cb, opts)` faz um fork do EM, abre a transação, executa `cb(em)`, dá **flush antes do commit** e faz rollback se houver exceção. Use **sempre** o `em` recebido no callback. Ver [transactions](https://mikro-orm.io/docs/transactions).
- A propagação padrão é **NESTED** em `em.transactional` (vira **savepoint** quando já existe uma transação aberta) e **REQUIRED** em `@Transactional()`.
- `TransactionOptions` aceita `isolationLevel`, `readOnly`, `clear`, `flushMode`, `signal` (AbortSignal) e `propagation`.
- **Isolation:** fique no `READ COMMITTED` (o padrão do PG) com `SELECT … FOR UPDATE`. `REPEATABLE READ`/`SERIALIZABLE` geram `40001`, que o MikroORM converte em `DeadlockException` (seção 8).
- **Contexto:** com `allowGlobalContext: false` (padrão), chamar `orm.em.find()` fora de um contexto lança `ValidationError`. No HTTP, o `MikroOrmModule` registra um middleware de RequestContext.
- **Fora do HTTP** (consumer SQS, worker de outbox, cron), o middleware **não roda** ([usage-with-nestjs](https://mikro-orm.io/docs/usage-with-nestjs)). Há três opções:
  1. `@CreateRequestContext()` (`@mikro-orm/decorators/legacy`) num método **async** de topo. A classe precisa injetar `MikroORM` como `orm`, ou você passa `@CreateRequestContext(() => orm)`. Desde a v7, aplicar em método não-async lança erro.
  2. `@EnsureRequestContext()` faz o mesmo, mas reaproveita o contexto que já existir.
  3. Sem decorator, `const em = orm.em.fork(); await em.transactional(async tx => …)`. É o mais explícito, e o recomendado para loops de worker: **um fork por mensagem/lote**, para o identity map não crescer.

```ts
@Injectable() class OrderConsumer {
  constructor(private readonly orm: MikroORM) {}
  @CreateRequestContext()
  async handle(msg: Msg) {
    await this.orm.em.transactional(async (em) => { /* ... */ });
  }
}
```

- Chame `app.enableShutdownHooks()`. Sem ele, o `orm.close()` não roda no SIGTERM ([usage-with-nestjs](https://mikro-orm.io/docs/usage-with-nestjs)). Na v7, o `MikroOrmModule.forRoot()` exige um objeto de opções explícito.

> **RISCO — PG aborta a transação inteira em qualquer erro.** Depois de um `23505` (unique violation), *nenhum* comando roda mais na mesma transação (`25P02 current transaction is aborted`). Um backstop do tipo "captura o `UniqueConstraintViolationException`, relê e devolve replay" precisa **ou** de um savepoint (um `em.transactional` aninhado, NESTED por padrão, em volta só do INSERT) **ou** de rodar depois do rollback, numa transação nova.

> **RISCO — transações paralelas no mesmo EM.** A doc avisa: transações paralelas pedem um fork novo ou `clear: true`. Nunca compartilhe o mesmo `em` entre `Promise.all`.

## 5. Locking

`LockMode` (core): `NONE`, `OPTIMISTIC`, `PESSIMISTIC_READ` (`FOR SHARE`), `PESSIMISTIC_WRITE` (`FOR UPDATE`), `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`), `PESSIMISTIC_WRITE_OR_FAIL` (`FOR UPDATE NOWAIT`), `PESSIMISTIC_PARTIAL_READ`, `PESSIMISTIC_READ_OR_FAIL`.

```ts
await em.transactional(async (em) => {
  await em.execute(`set local lock_timeout = '3s'`);          // ver RISCO abaixo
  const acc = await em.findOneOrFail(AccountSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
  // ...
});
// fila/outbox: FOR UPDATE SKIP LOCKED
const rows = await em.qb(OrderSchema, 'o').select('*')
  .where({ publishedAt: null }).orderBy({ createdAt: 'asc' }).limit(50)
  .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE, ['o']).getResult();
```

- Um lock pessimista **sem transação aberta lança exceção** ([transactions](https://mikro-orm.io/docs/transactions)).
- Com `lockTableAliases: ['o']` em `find`/`findOne`, ou com o 2º argumento de `setLockMode`, o SQL sai como `FOR UPDATE OF "o"`. Use isso sempre que houver join, para não travar tabelas relacionadas.
- `em.lock(entity, LockMode.PESSIMISTIC_WRITE)` trava uma entidade que já está gerenciada. `em.lock(entity, LockMode.OPTIMISTIC, expectedVersion)` confere a versão.
- **Optimistic:** com `version: true`, o flush faz `UPDATE … WHERE version = ?`. Se a versão não bater, lança `OptimisticLockError`. Isso **complementa** o `FOR UPDATE` como cinto de segurança; não o substitui.

> **RISCO — não existe opção `lockTimeout` no MikroORM 7** (não há ocorrência nos pacotes). Configure no PG: `SET LOCAL lock_timeout` dentro da transação, ou `options: '-c lock_timeout=3000'` no `driverOptions`/`clientUrl`, ou `onReserveConnection`. Sem isso, um `FOR UPDATE` espera indefinidamente.

> **RISCO — `SKIP LOCKED` + `LIMIT` + `ORDER BY`** dão "pelo menos alguém pega" e não garantem ordem global. Não use para nada que dependa de ordenação estrita.

## 6. SQL raw, QueryBuilder e ON CONFLICT

- `em.execute(sql, params, 'all' | 'get' | 'run')` (ou `{ method }` como 3º argumento) respeita a **transação corrente**, mapeia exceptions e loga ([query-builder](https://mikro-orm.io/docs/query-builder)). A forma de baixo nível é `em.getConnection().execute(sql, params, method, ctx)`; nesse caso **passe `ctx`** (`em.getTransactionContext()`), senão a query roda fora da transação.
- Na v7 o **QB não é awaitable**. Termine com `.execute()` para resultado cru ou com `.getResult()`/`.getSingleResult()` para entidades.
- Para fragmentos, use `raw()` ou o template `sql\`...\``. Na v7 o `raw()` retorna `RawQueryFragment`.
- Também há o `em.getKysely()` para queries tipadas do Kysely. Ele participa da transação do `em`, desde que seja o `em` da transação.

**INSERT … ON CONFLICT DO NOTHING (dedup):**

```ts
const res = await em.qb(EventLogSchema).insert({ sourceId, externalId, seenAt })
  .onConflict(['sourceId', 'externalId']).ignore().execute('run');
const isDuplicate = res.affectedRows === 0;
```

- `em.upsert(Entity, data, { onConflictFields, onConflictAction: 'ignore' | 'merge', onConflictMergeFields, onConflictExcludeFields, onConflictWhere })` faz `insert … on conflict` e devolve uma entidade gerenciada ([entity-manager](https://mikro-orm.io/docs/entity-manager)).

> **RISCO — `em.upsert` com `'ignore'`:** a doc não diz o que acontece quando a linha já existe (no PG, `DO NOTHING` não retorna linha, e o ORM pode fazer um SELECT extra). Para dedup, use o QB com `.ignore()` e leia `affectedRows`. Verificar no spike.

## 7. Migrations

- `@mikro-orm/migrations` + `extensions: [Migrator]`. Padrões: `transactional: true` (cada migration em transação), `allOrNothing: true` (todas numa transação mestre), `snapshot: true`, `emit: 'ts'`, tabela `mikro_orm_migrations` ([migrations](https://mikro-orm.io/docs/migrations)).
- `down()` é opcional e **lança erro por padrão**. Implemente sempre, porque o desafio exige up/down.
- SQL raw entra com `this.addSql(...)`. Funciona para trigger, `CREATE UNIQUE INDEX … WHERE …` (unique parcial) e `CHECK`:

```ts
export class Migration20261010_init extends Migration {
  async up() {
    this.addSql(`create unique index order_one_reversal on orders (reference_id) where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');`);
    this.addSql(`alter table accounts add constraint accounts_balance_ck check (balance >= 0);`);
  }
  async down() {
    this.addSql(`alter table accounts drop constraint accounts_balance_ck;`);
    this.addSql(`drop index order_one_reversal;`);
  }
}
```

- Programaticamente: `await orm.migrator.up()`, `orm.migrator.down({ to: 0 })`, `getPending()` e `create()`. Na v7 são getters, sem `getMigrator()`.
- CLI: `migration:create [--blank]`, `migration:up|down [--to|--only]`, `migration:pending`, `migration:check` e `migration:fresh`.
- Um `CREATE INDEX CONCURRENTLY` não roda dentro de transação. Para esses casos, sobrescreva `isTransactional() { return false }` na migration.

> **RISCO — o diff do schema e o SQL escrito à mão.** O `migration:create` (diff) e o `migration:check` comparam com os metadados. O que só existe em `addSql` (unique parcial, CHECK, trigger) pode aparecer como "drop" no próximo diff (`schemaGenerator.ignoreTriggers` vem `false`). Escolha **uma** das saídas: escreva migrations à mão com `--blank`, sem confiar no diff, **ou** declare `indexes` (com `expression`), `checks` e `triggers` também nos metadados (a v7 suporta). Rode up → down → up no CI.

> **RISCO — `.ts` sob Bun:** na v6, o `migrator.up()` sob Bun falhava ao importar a classe da migration ([#5348](https://github.com/mikro-orm/mikro-orm/issues/5348), [#5689](https://github.com/mikro-orm/mikro-orm/issues/5689)). A v7 removeu o umzug, o que deve resolver, mas **verificar no spike** que `orm.migrator.up()` carrega `.ts` sob `bun`.

## 8. Tratamento de erros

As classes vêm de `@mikro-orm/core`: `DriverException` → `ServerException` → `ConstraintViolationException` → `UniqueConstraintViolationException`, `CheckConstraintViolationException`, `ForeignKeyConstraintViolationException`, `NotNullConstraintViolationException`; e mais `DeadlockException`, `LockWaitTimeoutException`, `ConnectionException`, `TableNotFoundException`, `SyntaxErrorException`. Fora dessa hierarquia ficam `OptimisticLockError` e `ValidationError`.

Mapeamento real do `PostgreSqlExceptionConverter` (7.2.5):

| SQLSTATE | Classe |
|---|---|
| `23505` | `UniqueConstraintViolationException` |
| `23514` | `CheckConstraintViolationException` |
| `23503` | `ForeignKeyConstraintViolationException` |
| `23502` | `NotNullConstraintViolationException` |
| `40P01` **e `40001`** | `DeadlockException` |
| `55P03` (lock_not_available, gerado pelo `lock_timeout`/`NOWAIT`), `57014` (query_canceled, gerado pelo `statement_timeout`), `ECONNREFUSED`… | **não mapeados** → `DriverException` genérico |

> **RISCO — `LockWaitTimeoutException` e `ConnectionException` nunca saem do driver PG.** Para classificar timeout de lock e conexão perdida como "transitório/503", leia o `code` do erro: `(e as DriverException).code` (`'55P03'`, `'57014'`, `'ECONNREFUSED'`, `'57P01'`…).

> **RISCO — saber qual unique foi violado.** O nome da constraint vem no erro do `pg`, mas não está tipado ([#7537](https://github.com/mikro-orm/mikro-orm/issues/7537), o mantenedor recomenda cast). Use `(e as UniqueConstraintViolationException & { constraint?: string }).constraint` para diferenciar, por exemplo, `idempotency_key` de `(provider_id, external_transaction_id)`.

## 9. Pool de conexões e health check

- A v7 usa `pg.Pool` via `PostgresDialect` do Kysely. `pool.min`, `pool.max` e `pool.idleTimeoutMillis` são repassados ao `pg.Pool` (`PostgreSqlConnection.mapOptions`).
- `driverOptions` é passado **direto** ao client, sem o aninhamento `connection` (veja [#driveroptions-structure-changed](https://mikro-orm.io/docs/upgrading-v6-to-v7#driveroptions-structure-changed)). Use, por exemplo, `driverOptions: { ssl, options: '-c statement_timeout=5000 -c lock_timeout=3000', connectionTimeoutMillis: 2000 }`. Também aceita uma instância ou um dialect do Kysely.
- `onReserveConnection` é aguardado a cada checkout do pool (PG/MySQL/MSSQL), o que serve para `SET` de sessão ([configuration](https://mikro-orm.io/docs/configuration)).
- O driver registra handler de `error` no pool e nos clients: uma conexão derrubada pelo servidor não mata o processo.
- **Dimensionamento com várias instâncias:** `instâncias × pool.max` precisa caber em `max_connections` do PG, descontada a folga para migrations e admin. Cada wallet travada segura uma conexão pela duração da transação, então mantenha as transações curtas.
- **Health:** `await orm.checkConnection()` → `{ ok: true } | { ok: false, reason, error? }`, e `await orm.isConnected()` → `boolean`. Para `/health/ready`, use `checkConnection()` com timeout próprio.

## 10. Compatibilidade com Bun

- O core detecta Bun (`process.versions.bun`) como ambiente com suporte a TS, então `.ts` funciona sem ts-node/tsx. A CLI pula o registro de loader no Bun (`CLIHelper.registerTypeScriptSupport`). Com `MIKRO_ORM_CLI_CONFIG=*.ts`, o `preferTs` é ligado sozinho.
- A CLI procura a config nesta ordem: `MIKRO_ORM_CLI_CONFIG`, depois `configPaths` (chave `"mikro-orm"` do package.json), depois `./src/mikro-orm.config.ts` e por fim `./mikro-orm.config.ts`.

> **RISCO — a CLI roda no Node mesmo com `bun run mikro-orm`.** O shebang é `#!/usr/bin/env node`; se houver Node no PATH, ele interpreta a config `.ts` e falha ([#7035](https://github.com/mikro-orm/mikro-orm/issues/7035)). Use **`bunx --bun mikro-orm migration:up`** (o mantenedor sugere `bunx -b`) ou `bun --bun run mikro-orm …`. Alternativa mais robusta: um script próprio `bun run scripts/migrate.ts` chamando `orm.migrator.up()`.

> **RISCO — TsMorph sob Bun:** o Bun muda o formato dos stack traces e quebra o `lookupPathFromDecorator` ([#7381](https://github.com/mikro-orm/mikro-orm/issues/7381)). Com `EntitySchema` e o metadata provider padrão, o problema não ocorre. **Não** instale `@mikro-orm/reflection`.

- Outros pontos: com `bun build`, divergência entre `name` e o nome da classe duplicava entidades no discovery ([#7391](https://github.com/mikro-orm/mikro-orm/issues/7391), corrigido; mantenha `name` igual ao nome da classe ou omita). O glob via tinyglobby quebrava em Windows + Bun ([#7539](https://github.com/mikro-orm/mikro-orm/issues/7539), corrigido na 7.0.10). Passar entidades explícitas evita o glob.
- `bun test` com Nest e MikroORM: os decorators legados do Nest exigem `experimentalDecorators` e `emitDecoratorMetadata` no tsconfig, que o Bun respeita. Os decorators do MikroORM vêm de `@mikro-orm/decorators/legacy`, e não de `/es`.
- **Checklist do spike (Fase 0):** `orm.migrator.up/down` com `.ts` sob `bun`; `bunx --bun mikro-orm migration:create --blank`; `numeric` voltando como string; `em.upsert` com ignore vs QB `.ignore()`; `SET LOCAL lock_timeout` + `55P03` capturado; 2 processos `bun` disputando `FOR UPDATE`.
