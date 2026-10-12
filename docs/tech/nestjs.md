# NestJS — Guia de boas práticas (Bun + Hexagonal + MikroORM + SQS)

> Pesquisa feita em 2026-10-10 na documentação oficial (docs.nestjs.com), npm registry e GitHub issues.
> Escopo: o que importa para este desafio (§4, §5, §10, §12 do `CHALLENGE.md`). Os snippets são **ilustrativos**, não código do projeto.
> Legenda: **[RISCO]** = armadilha conhecida, com mitigação.

---

## 1. Versões e pacotes

| Pacote | Versão estável (npm, out/2026) | Nota |
|---|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/testing` | **12.1.2** | v12: pacotes core **ESM-only** (CJS continua funcionando via `require(esm)`) |
| `@nestjs/platform-express` | 12.1.2 | **Recomendado** (ver abaixo) |
| `@nestjs/platform-fastify` | 12.1.2 | alternativa |
| `@nestjs/config` | 12.0.1 | `validationSchema` agora aceita Standard Schema |
| `@nestjs/terminus` | 12.1.0 | API legada de indicator (`HealthCheckError`) **removida** |
| `@nestjs/schedule` | 12.0.2 | |
| `@nestjs/swagger` | 12.0.2 | |
| `@mikro-orm/core` / `postgresql` / `nestjs` | 7.2.5 / 7.2.5 / 7.1.0 | v7: config precisa ser passada explicitamente em `forRoot(config)` |
| `nestjs-pino` / `pino-http` / `pino` | 5.3.1 / 11 / 10 | |
| `nestjs-cls` | 7.0.1 | peer `@nestjs/* >=10 <13` |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 | |
| `sqs-consumer` | 15.0.4 | sem dependência de Nest |
| `bun` | 1.4.2 | |

Fontes: [Migration guide v11→v12](https://docs.nestjs.com/migration-guide), [Performance (Fastify)](https://docs.nestjs.com/techniques/performance).

**Recomendação: `@nestjs/platform-express`.**
- É o default, com maior compatibilidade de middleware/recipes; na v12 o adapter Express **drena requisições em andamento no shutdown** (migration guide) — exatamente o que precisamos para graceful shutdown.
- Fastify é ~2x mais rápido em benchmark, mas o gargalo aqui é PostgreSQL (`FOR UPDATE` em wallet quente), não o HTTP. Fastify também exige `listen(port, '0.0.0.0')` em container e tem diferenças em `req/res` em middleware.

Checklist:
- [ ] Fixar versões exatas no `package.json` (`bun install --exact`) e commitar `bun.lock`.
- [ ] Não migrar o próprio app para ESM só por causa da v12 (opcional segundo o guia); se migrar, imports relativos precisam de `.js` e `import.meta.dirname`.
- **[RISCO]** `@ssut/nestjs-sqs@3.0.1` declara peer `@nestjs/* ^11` (não suporta v12). Prefira `sqs-consumer` ou um loop próprio com `@aws-sdk/client-sqs` dentro de um provider Nest.
- **[RISCO]** v12 mudou a ordem dos lifecycle hooks: agora executam “por nível de hierarquia de componente”. Não dependa de ordem implícita entre módulos irmãos.

---

## 2. Módulos e injeção de portas (hexagonal)

Fonte: [Custom providers](https://docs.nestjs.com/fundamentals/custom-providers), [Modules](https://docs.nestjs.com/modules).

Regras:
- `domain/` e `application/` **não importam `@nestjs/*`**. Use cases são classes puras que recebem portas no construtor.
- O Nest só existe em `infrastructure/` (módulo, controllers, adapters) e é quem faz a “cola” via custom providers.
- Interfaces não existem em runtime → **não podem ser token**. Use `Symbol` exportado junto da porta (ou classe abstrata).
- Um módulo Nest por bounded context (`WalletModule`, `WageringModule`, `MessagingModule`, `HealthModule`); exporte só as portas/use cases que outro contexto precisa.

```ts
// application/ports/wallet-repository.port.ts  (sem Nest)
export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
export interface WalletRepository { findForUpdate(id: WalletId): Promise<Wallet | null>; save(w: Wallet): Promise<void>; }

// infrastructure/wagering.module.ts
@Module({
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: CLOCK, useValue: systemClock },
    {
      provide: ProcessWagerTransaction,              // use case puro: Nest não vê decorators
      useFactory: (repo: WalletRepository, clock: Clock, uow: UnitOfWork) =>
        new ProcessWagerTransaction(repo, clock, uow),
      inject: [WALLET_REPOSITORY, CLOCK, UNIT_OF_WORK],
    },
  ],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}

// adapter (infra) que precisa da porta
constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}
```

Checklist:
- [ ] `useFactory` + `inject` para instanciar use cases sem `@Injectable()` no application layer.
- [ ] `useClass` para adapters; `useValue` para constantes/fakes; `useExisting` para alias.
- [ ] Tokens `Symbol` definidos em **um único arquivo** e reutilizados (cada `Symbol()` é único).
- [ ] HTTP controller e SQS consumer injetam **o mesmo** use case (§10).
- **[RISCO]** Esquecer `@Inject(TOKEN)` em parâmetro tipado por interface → Nest resolve `Object` e falha com `UnknownDependenciesException`.
- **[RISCO]** v12: `@Optional()` não é mais herdado por subclasses — dependências opcionais em classes base passam a lançar erro.

---

## 3. Validação

Fontes: [Validation](https://docs.nestjs.com/techniques/validation), [Custom decorators](https://docs.nestjs.com/custom-decorators), [Pipes](https://docs.nestjs.com/pipes).

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,              // remove campos sem decorator
  forbidNonWhitelisted: true,   // ...ou melhor: rejeita (400) campos desconhecidos
  transform: true,              // instancia o DTO
  transformOptions: { enableImplicitConversion: false }, // não converter "10.00" → number
  stopAtFirstError: true,
  exceptionFactory: (errors) => new RequestValidationError(errors), // formato próprio (seção 4)
}));
```

Checklist:
- [ ] Valores monetários como **string** no DTO (`@Matches(/^(0|[1-9]\d*)\.\d{2}$/)`), nunca `@IsNumber()`; `Money.from` no use case.
- [ ] `enableImplicitConversion` **desligado** (evita coerção silenciosa de string→number em dinheiro).
- [ ] DTOs são classes concretas; **não importar DTO com `import type`** (a doc avisa: type-only import é apagado em runtime e a validação some).
- [ ] DTO ≠ comando do use case: o controller mapeia DTO → comando de aplicação.
- [ ] Preferir `APP_PIPE` em módulo se o pipe precisar de DI; `useGlobalPipes` não injeta dependências.

**Header `Idempotency-Key`**: `ValidationPipe` não valida headers por padrão (`@Headers()` não passa por metatype de classe útil). Duas opções:
1. Pipe dedicado: `@Headers('idempotency-key', new IdempotencyKeyPipe()) key: string` — o pipe valida presença, tamanho e charset e lança o erro de payload inválido.
2. Param decorator customizado via `createParamDecorator` + `new ValidationPipe({ validateCustomDecorators: true })` (por padrão o `ValidationPipe` **ignora** custom decorators).

- [ ] Header ausente/vazio/inválido → mesmo status/código de “payload inválido” (consistência exigida no §9).
- [ ] Documentar o header no Swagger com `@ApiHeader({ name: 'Idempotency-Key', required: true })`.

---

## 4. Exception filters: erro de domínio → HTTP

Fonte: [Exception filters](https://docs.nestjs.com/exception-filters).

Princípios:
- Domínio lança erros próprios (`InsufficientFundsError`, `IdempotencyConflictError`…) **sem** `HttpException`. Rejeição de regra de negócio que é **persistida** (REJECTED) é um *resultado* do use case, não exceção.
- Um único **catch-all** global com `HttpAdapterHost` (agnóstico a Express/Fastify) faz o mapeamento por tabela.
- Registrar via `APP_FILTER` (permite injetar logger/métricas); `useGlobalFilters` não tem DI.
- Exceções de middleware só chegam a filtros **globais**.

```ts
@Catch()
export class ErrorMappingFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost, private readonly logger: PinoLogger) {}
  catch(err: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const { status, body } = toHttpError(err);         // tabela única, testada à parte
    if (status >= 500) this.logger.error({ err }, 'unhandled');
    httpAdapter.reply(host.switchToHttp().getResponse(), body, status);
  }
}
// providers: [{ provide: APP_FILTER, useClass: ErrorMappingFilter }]
```

Formato de corpo sugerido (estável, legível por máquina):
```json
{ "error": { "code": "IDEMPOTENCY_CONFLICT", "message": "…", "retryable": false, "correlationId": "…", "details": [] } }
```

Checklist:
- [ ] Tabela explícita e documentada, ex.: payload inválido → 400/422 · conflito de idempotência → 409 · regra de negócio (REJECTED) → 422 · aceito pendente (`PENDING_REFERENCE`) → 202 · infra transitória (DB/SQS fora, lock timeout, serialization failure) → 503 + `Retry-After`.
- [ ] Campo `retryable` + `code` estável (o provedor decide reenvio sem ler `message`).
- [ ] `correlationId` sempre no corpo e no header de resposta.
- [ ] Nunca vazar stack/SQL no corpo; logar com `cause`.
- [ ] Erro desconhecido → 500 genérico (não 503: não induzir retry de bug).
- **[RISCO]** Ordem de filtros: se combinar catch-all com filtros específicos, declare o catch-all **primeiro**. Mais simples: um único filtro.

---

## 5. correlationId e AsyncLocalStorage

Fontes: [Async Local Storage recipe](https://docs.nestjs.com/recipes/async-local-storage), [Middleware](https://docs.nestjs.com/middleware), [Interceptors](https://docs.nestjs.com/interceptors), [nestjs-cls](https://papooch.github.io/nestjs-cls/setting-up-cls-context).

Recomendação: **`nestjs-cls`** (recomendado pela própria doc; suporta HTTP *e* não-HTTP) — ou ALS nativo se quiser zero dependência.

- **HTTP**: use **middleware** (não interceptor) para abrir o contexto — middleware roda antes de guards/pipes/filters, então o filtro de erro também enxerga o `correlationId`.
- **SQS consumer / workers**: não há request → abra o contexto manualmente por mensagem/tick (`cls.run(...)` ou `@UseCls()`), usando `correlationId` da mensagem.

```ts
ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: (req) => req.headers['x-correlation-id'] ?? randomUUID(),
  },
});

// consumer
await this.cls.run(async () => {
  this.cls.set('correlationId', msg.body.correlationId ?? msg.MessageId);
  await this.useCase.execute(cmd);
});
```

Checklist:
- [ ] Sanitizar o header recebido (tamanho/charset) antes de aceitar como id.
- [ ] Devolver `X-Correlation-Id` na resposta.
- [ ] Propagar o `correlationId` para o evento da outbox (§11) — persistir no registro, não ler do ALS no worker.
- [ ] Logger lê o id do mesmo contexto (seção 9).
- [ ] Use case **não** lê ALS diretamente; se precisar, recebe via comando ou porta `RequestContext`.
- **[RISCO] Bun**: issues abertas de ALS — contexto perdido em `unhandledRejection` ([#40223](https://github.com/oven-sh/bun/issues/40223), [#44650](https://github.com/oven-sh/bun/issues/44650)), em `import()` dinâmico ([#32693](https://github.com/oven-sh/bun/issues/32693)) e `bun:test` tratando hooks registrados dentro de `als.run` como done-callback ([#44552](https://github.com/oven-sh/bun/issues/44552)). Mitigação: sempre `await` dentro do `run`, sem import dinâmico no caminho quente, teste de integração que verifica o `correlationId` nos logs.

---

## 6. Lifecycle e graceful shutdown

Fonte: [Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events).

Ordem: `onModuleInit` → `onApplicationBootstrap` → *(listen)* … `SIGTERM` → `onModuleDestroy` → `beforeApplicationShutdown(signal)` → *(conexões HTTP fecham)* → `onApplicationShutdown(signal)`. Hooks async são aguardados em sequência.

Mapeamento recomendado:
| Hook | O que fazer |
|---|---|
| `onApplicationBootstrap` | iniciar consumer SQS e loops de worker (depois que tudo foi injetado; DB pronto) |
| `onModuleDestroy` | **parar de pegar trabalho novo**: `consumer.stop()` / flag `stopping = true` / `AbortController.abort()` no long poll |
| `beforeApplicationShutdown` | **aguardar o trabalho em voo** (mensagens em processamento, tick atual do worker) com timeout < `terminationGracePeriod` |
| `onApplicationShutdown` | fechar recursos (MikroORM fecha a conexão sozinho com shutdown hooks; `sqsClient.destroy()`) |

```ts
// main.ts
app.enableShutdownHooks();          // opt-in! sem isso nenhum hook de shutdown roda em SIGTERM

// worker/consumer (infra)
async onModuleDestroy() { this.stopping = true; this.abort.abort(); }
async beforeApplicationShutdown() { await withTimeout(Promise.allSettled(this.inFlight), 20_000); }
```

Checklist:
- [ ] `app.enableShutdownHooks()` chamado no bootstrap (MikroORM também depende disso para fechar o pool — [doc MikroORM](https://mikro-orm.io/docs/usage-with-nestjs)).
- [ ] Mensagem em voo: termina → commit → `DeleteMessage`. Se o timeout estourar, **não** dar ack: a mensagem volta após o visibility timeout e a inbox garante idempotência.
- [ ] Health readiness passa a falhar no início do shutdown (seção 8) para o balanceador parar de mandar tráfego.
- [ ] `app.close()` não encerra o processo: limpar `setInterval`/timers, senão o processo não sai.
- [ ] Hooks **não rodam** em providers request-scoped — workers/consumer devem ser singleton.
- **[RISCO]** Em Docker, Bun como PID 1 deve receber `SIGTERM` normalmente, mas use `exec`/forma JSON no `CMD` (ou `--init`/tini) para o sinal não ficar preso no shell.
- **[RISCO] Bun**: `SIGTERM/SIGINT` não entregue quando `process.stdin` tem listener `data` ([#30189](https://github.com/oven-sh/bun/issues/30189)) — não ler stdin no processo da API.
- **[RISCO]** Vários apps Nest no mesmo processo (testes) + `enableShutdownHooks` → warning de “too many listeners”; em testes, não habilite, chame `app.close()`.

---

## 7. Background workers (outbox publisher, reprocessamento de `PENDING_REFERENCE`)

Fontes: [Task scheduling](https://docs.nestjs.com/techniques/task-scheduling), [`@nestjs/locks`](https://github.com/nestjs/locks).

`@nestjs/schedule`:
- `@Cron`/`@Interval`/`@Timeout`; jobs iniciam em `onApplicationBootstrap`; `waitForCompletion: true` evita sobreposição **no mesmo processo** (ticks atrasados são descartados).
- A doc avisa: com N instâncias, **cada job roda N vezes**. Sugere `@OnOneInstance()` de `@nestjs/locks` (lease em Postgres/Redis).
- `ScheduleModule.forRoot()` em **um** módulo só.

**Recomendação para este desafio: loop próprio, sem líder**, todas as instâncias trabalhando em paralelo com claim no banco:
```sql
SELECT … FROM outbox_messages
WHERE published_at IS NULL AND next_attempt_at <= now()
ORDER BY occurred_at
LIMIT $batch
FOR UPDATE SKIP LOCKED;
```
- Mais simples de reiniciar/parar (seção 6), throughput escala com instâncias, e o critério de avaliação exige “múltiplos publishers concorrentes” (§11) — eleição de líder com `@OnOneInstance` atende a correção, mas desperdiça as demais instâncias e cria janela de failover.
- Se usar `@nestjs/schedule`, use `@Interval` + `waitForCompletion`/flag `running` e mantenha o `SKIP LOCKED`; nunca confie no scheduler para exclusividade.

Checklist:
- [ ] Claim com `FOR UPDATE SKIP LOCKED` (ou lease com `locked_until`) em transação curta; publicar; marcar `published_at`.
- [ ] Publicação é *at-least-once*: consumidores downstream deduplicam por `eventId`.
- [ ] Backoff exponencial persistido (`attempts`, `next_attempt_at`), limite e DLQ/estado terminal.
- [ ] Jitter no intervalo do loop; batch configurável; métricas de lag da outbox.
- [ ] Cada tick roda em **contexto MikroORM próprio** (`@CreateRequestContext()` no método top-level ou `em.fork()`), senão o Identity Map global vaza entre ticks.
- [ ] Cada tick roda em contexto CLS/pino próprio (seção 5/9).
- **[RISCO]** `@nestjs/locks` está em `0.0.2` (imaturo) — não depender dele para correção.
- **[RISCO]** Usar `em` global fora de request: MikroORM lança erro de *global context* (ou pior, compartilha identity map). Sempre fork/RequestContext.

---

## 8. Health checks (`@nestjs/terminus`)

Fonte: [Health checks (Terminus)](https://docs.nestjs.com/recipes/terminus).

- `GET /health/live`: **não** consulta dependências (só “processo responde”). Falhar liveness por DB fora causa restart em cascata.
- `GET /health/ready`: `MikroOrmHealthIndicator` (ping) + indicador customizado de SQS (`GetQueueAttributes` na fila principal).
- v12: indicador customizado usa `HealthIndicatorService` (`check(key).up()/down()` ou `attempt()`); **`HealthCheckError` foi removido**. Timeout via `.withTimeout(ms)` (a opção `timeout` está deprecated).

```ts
@Injectable()
export class SqsHealthIndicator {
  constructor(private readonly hi: HealthIndicatorService, @Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}
  async isHealthy(key = 'sqs') {
    const i = this.hi.check(key);
    try { await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] })); return i.up(); }
    catch (e) { return i.down({ message: 'unreachable' }); }
  }
}

@Get('ready') @HealthCheck()
ready() { return this.health.check([() => this.db.pingCheck('postgres'), () => this.sqs.isHealthy()]); }
```

Checklist:
- [ ] `TerminusModule.forRoot({ gracefulShutdownTimeoutMs: N })` → em `SIGTERM`, readiness responde `503 shutting_down` por N ms antes de fechar (requer `enableShutdownHooks`).
- [ ] Indicadores devolvem `down()`; **não lançar** — exceção lançada vira 500 em vez de 503.
- [ ] Timeouts curtos (≤ 1–2 s) por dependência; não enviar detalhes sensíveis (URLs com credenciais).
- [ ] Endpoints de health sem auth (§9), excluídos do request log automático.
- [ ] Opcional: `cacheFor()` para não martelar o banco sob probes frequentes.

---

## 9. Logging (`nestjs-pino`)

Fontes: [Logger](https://docs.nestjs.com/techniques/logger), [nestjs-pino](https://github.com/iamolegga/nestjs-pino).

A doc oficial: o `ConsoleLogger` com `json: true` basta para casos simples; use Pino quando precisar de **redaction** e throughput — é o nosso caso (§12 proíbe dados sensíveis nos logs).

```ts
// main.ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));        // antes de app.listen()

// app.module.ts (LoggerModule só no root!)
LoggerModule.forRootAsync({ inject: [ClsService], useFactory: (cls) => ({
  pinoHttp: {
    level: env.LOG_LEVEL,
    genReqId: () => cls.getId(),                         // mesmo id do CLS
    customProps: () => ({ correlationId: cls.getId() }),
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body', '*.amount', '*.balance'], remove: true },
    autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
  },
})});
```

Checklist:
- [ ] JSON em stdout em todos os ambientes; `pino-pretty` só em dev local e **sem** `transport` (worker thread) em produção.
- [ ] Campos padrão: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` (§12) via `logger.assign()` / bindings.
- [ ] Fora de HTTP: `PinoLogger.runInContext(fn, { bindings })` no consumer/worker.
- [ ] Logs nos serviços via `new Logger(Ctx.name)` (API padrão do Nest) — o domínio não loga.
- [ ] Registrar `LoggerModule` **uma vez** (importar de novo duplica logs).
- **[RISCO] Bun**: transport do pino (thread-stream worker) travou ~10 s no exit sob Bun ([#32157](https://github.com/oven-sh/bun/issues/32157), fechado). Evite transports; escreva direto em stdout.

---

## 10. Testing (`@nestjs/testing` + `bun test`)

Fonte: [Testing](https://docs.nestjs.com/fundamentals/testing).

```ts
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(CLOCK).useValue(fixedClock)        // override por token Symbol
  .compile();
const app = moduleRef.createNestApplication();
await app.init();
const res = await request(app.getHttpServer()).post('/transactions').set('Idempotency-Key', 'k').send(body);
expect(res.status).toBe(201);
afterAll(() => app.close());
```

Checklist:
- [ ] **Unit** (domínio + use cases): sem Nest; instanciar classes direto com fakes das portas — mais rápido e não depende de decorators.
- [ ] **Integração/e2e**: Postgres e SQS reais (MiniStack/Testcontainers) — o §14 penaliza mockar tudo. Use `overrideProvider` só para relógio/ids/falha injetada.
- [ ] `overrideModule().useModule()` para trocar um módulo inteiro; `useMocker()` para auto-mock em unit de adapters.
- [ ] Sempre `await app.close()` no `afterAll` (senão o processo de teste não termina).
- [ ] Concorrência multi-instância: subir N processos reais (`Bun.spawn`) em vez de N apps no mesmo processo.
- **[RISCO] Bun — supertest não é aguardado se apenas retornado**: `bun test` só aguarda `Promise` nativa; o request do supertest é *thenable* → `return request(...).expect(200)` **passa sem executar** ([#27945](https://github.com/oven-sh/bun/issues/27945), fix [PR #41008](https://github.com/oven-sh/bun/pull/41008) ainda **aberto**). Regra: **sempre `await request(...)`** e asserte no resultado.
- **[RISCO] Bun**: processo pode não sair após supertest+Express ([#23648](https://github.com/oven-sh/bun/issues/23648)) → `app.close()` + `--timeout` no `bun test`.
- **[RISCO]** `bun test` não tem `jest.mock` com hoisting; use `mock.module()` ou (melhor) injeção por porta. A doc oficial usa Vitest/Jest; Nest não é testado oficialmente com `bun:test`.
- **[RISCO]** Hooks/tests dentro de `als.run` em `bun:test` ([#44552](https://github.com/oven-sh/bun/issues/44552)): não registrar `it/onTestFinished` dentro de `cls.run`.

---

## 11. Config (`@nestjs/config`)

Fonte: [Configuration](https://docs.nestjs.com/techniques/configuration).

```ts
ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  ignoreEnvFile: true,          // Bun já carrega .env sozinho (ver risco)
  validate: validateEnv,        // class-validator: plainToInstance(..., { enableImplicitConversion: true }) + validateSync; throw → app não sobe
  // ou validationSchema: <Standard Schema (Zod/Valibot)>
});
// uso
config.getOrThrow<string>('DATABASE_URL');
@Inject(dbConfig.KEY) cfg: ConfigType<typeof dbConfig>   // registerAs('db', …)
```

Checklist:
- [ ] Validar **todas** as envs no boot (fail fast): URLs, timeouts, tamanho de batch, limites de retry/backoff, visibility timeout.
- [ ] `registerAs` por contexto (`db`, `sqs`, `worker`) + `ConfigType` para tipagem.
- [ ] `getOrThrow` em vez de `get` + `!`.
- [ ] Use cases recebem config via porta/valor injetado, nunca `ConfigService`.
- [ ] Secrets nunca no repositório; `.env.example` sem valores reais.
- **[RISCO] Bun lê `.env` automaticamente** ([#23967](https://github.com/oven-sh/bun/issues/23967)) — pode mascarar env faltando no container. Use `ignoreEnvFile: true` no Nest e/ou `bun --env-file=…` explícito; valide no boot.

---

## 12. Incompatibilidades conhecidas NestJS ↔ Bun

Posição oficial do Nest: foco em Node; “se o Bun funcionar, ótimo”, sem ajustes específicos ([nestjs/nest#15133](https://github.com/nestjs/nest/issues/15133)). Docs de testing não citam Bun.

| Problema | Status | Mitigação |
|---|---|---|
| `emitDecoratorMetadata` serializa `X \| undefined` como `X` (tsc emite `Object`) — [#44120](https://github.com/oven-sh/bun/issues/44120) | aberta | Não usar union com `undefined/null` em parâmetro de construtor injetado; tipos de DTO explícitos (`@Type(() => X)`) |
| Metadata não emitida se `tsconfig` herda de **pacote** (`extends: "@org/tsconfig"`) — [#6326](https://github.com/oven-sh/bun/issues/6326) | aberta (caminho relativo OK) | `experimentalDecorators`/`emitDecoratorMetadata` no `tsconfig.json` raiz ou `extends` relativo |
| “Cannot access uninitialized variable” com decorators + ordem de declaração — [#7591](https://github.com/oven-sh/bun/issues/7591) | aberta | Classes referenciadas em decorators declaradas antes / em arquivo próprio; evitar ciclos de import |
| `Import named 'X' not found` com `emitDecoratorMetadata` em imports só de tipo — [#6172](https://github.com/oven-sh/bun/issues/6172) | aberta | `import type` para tipos puros; **classes** usadas como token/DTO com import normal |
| Reflector/DI falha com deps duplicadas (`@nestjs/core` duas cópias) — [#9838](https://github.com/oven-sh/bun/issues/9838) | aberta | Uma única versão de `@nestjs/*`; checar `bun pm ls`; sem linker isolado se duplicar |
| `bun build --compile`/minify quebra `.name` de classes (DI usa nomes) — [#12304](https://github.com/oven-sh/bun/issues/12304), [#11836](https://github.com/oven-sh/bun/issues/11836) | aberta | Rodar `bun src/main.ts` direto (sem bundle/minify) |
| Bun 1.4.2 trava em CPUs sem AVX — [#43683](https://github.com/oven-sh/bun/issues/43683) | aberta | Imagem `oven/bun:*-baseline` em hosts antigos/QEMU |
| supertest thenable não aguardado — [#27945](https://github.com/oven-sh/bun/issues/27945) | aberta | Sempre `await` |
| ALS perde contexto em alguns cenários — seção 5 | abertas | Testar correlationId fim a fim |
| Nest CLI (`nest start --watch`) espera `dist/` / Node — [nestjs/nest#16660](https://github.com/nestjs/nest/issues/16660) | — | Não usar `nest start`; `bun --watch src/main.ts` em dev, `bun src/main.ts` em prod; `tsc --noEmit` para typecheck |

Checklist de setup Bun:
- [ ] `tsconfig.json`: `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `strict: true`.
- [ ] `import 'reflect-metadata'` como **primeira** linha de `main.ts` e do preload de teste (`bunfig.toml` → `[test] preload`).
- [ ] CI roda `tsc --noEmit` (o Bun só transpila, não checa tipos).
- [ ] Testar boot da imagem Docker real no CI (pega problemas de metadata/sinais que não aparecem localmente).

---

## Resumo rápido (TL;DR)

1. NestJS **12.1.2** + `platform-express` (drena requests no shutdown).
2. Portas = `Symbol`; use cases puros instanciados por `useFactory`.
3. `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`, sem conversão implícita); `Idempotency-Key` com pipe dedicado.
4. Um catch-all `APP_FILTER` com tabela erro→status e corpo `{ error: { code, retryable, correlationId } }`.
5. `nestjs-cls` via middleware; `cls.run` por mensagem SQS/tick.
6. `enableShutdownHooks`; parar em `onModuleDestroy`, drenar em `beforeApplicationShutdown`, fechar em `onApplicationShutdown`.
7. Workers: loop próprio + `FOR UPDATE SKIP LOCKED` em todas as instâncias; contexto MikroORM por tick.
8. Terminus: live sem deps; ready = Postgres + SQS; `gracefulShutdownTimeoutMs`.
9. `nestjs-pino` com `bufferLogs`, redaction e sem transports.
10. `bun test`: sempre `await` no supertest; infra real em integração; `tsc --noEmit` no CI.
