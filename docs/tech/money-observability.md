# Dinheiro (decimal.js) e Observabilidade (pino, métricas) — guia prático

> Contexto: CHALLENGE §5.1 (nada de `number` para dinheiro), §6.1 (`Money` com `Decimal`, `amount` string com 2 casas), §12 (logs JSON com `correlationId`/`messageId`/`transactionId`/`walletId`/`providerId`, sem payload financeiro completo; métricas de status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência). Runtime: **Bun 1.x** + NestJS.
> **⚠️ RISCO** = bug silencioso ou incompatibilidade se ignorado. Versões conferidas no npm em out/2026.

---

## 1. decimal.js (v10.6.0)

### Configuração
- Defaults: `precision: 20` (dígitos **significativos**), `rounding: ROUND_HALF_UP` (4), `toExpNeg: -7`, `toExpPos: 21`.
- `precision` vale para **resultados de operações** (`plus`, `minus`, `times`, `div`...). **Não** vale para o construtor nem para `toDecimalPlaces`, `round`, `abs`, `neg` etc.
- Use `Decimal.set({...})` (valida os valores); atribuição direta (`Decimal.precision = 0`) pula validação.

### Isolamento com `Decimal.clone()`
`Decimal.set` altera o construtor **global** — qualquer lib que use decimal.js é afetada. Crie um construtor próprio, encapsulado no `Money`:

```ts
import Decimal from 'decimal.js';
const MoneyDecimal = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });
```
- `clone({ defaults: true, ... })` parte dos defaults em vez das configurações atuais.
- ⚠️ RISCO — o resultado de `a.plus(b)` usa o construtor/config de **`a`** (testado: `new Decimal(1).plus(new MoneyDecimal(1))` é instância de `Decimal`). Nunca misture instâncias de construtores diferentes dentro do `Money`.
- ⚠️ RISCO — precision 20 é apertada para `numeric(19,2)` (19 dígitos significativos); em multiplicação/divisão pode arredondar sem aviso. 34 dá folga.
- `ROUND_HALF_UP` no decimal.js = empate "para longe do zero", **igual ao arredondamento do `numeric` do PostgreSQL**. `ROUND_HALF_EVEN` (6, banker's) diverge: testado `'2.345'` → `2.35` (HALF_UP) vs `2.34` (HALF_EVEN). Escolha um e documente.

### Criação, formatação e comparação
```ts
const v = new MoneyDecimal('25.00');   // sempre a partir de string
v.toFixed(2);                          // '25.00' — sempre notação normal, nunca exponencial
v.plus('0.10').eq('25.10');            // true
v.cmp(other);                          // -1 | 0 | 1 (NaN se algum for NaN)
v.gt(x) / gte / lt / lte / eq;         v.isZero(); v.isNeg(); v.isPos(); v.isFinite(); v.dp();
```
- Para serializar use `toFixed(2)`, **não** `toString()`/`toJSON()` (podem sair em notação exponencial abaixo de 1e-7 / acima de 1e21 e perdem zeros: `new Decimal('25.00').toString()` → `'25'`).
- `toFixed()` **sem** argumento não arredonda; `toFixed(2)` usa `rounding` do construtor (ou o `rm` passado).
- `new Decimal(0.1)` a partir de `number` herda o erro do float — nunca crie a partir de `number`.
- Erros são `Error` comum com mensagem começando por `[DecimalError]` → converta para erro de domínio.

### ⚠️ RISCO — o construtor aceita muito mais que "decimal com 2 casas"
Testado com decimal.js 10.6.0:

| Entrada | Resultado |
|---|---|
| `'1e3'` | `1000` (notação científica) |
| `'0x1A'`, `'0b11'`, `'0o7'` | `26`, `3`, `7` (hex/bin/octal) |
| `'Infinity'`, `'NaN'` | aceitos |
| `'1_000'` | `1000` (separador numérico!) |
| `'.5'`, `'5.'`, `'+5.00'` | aceitos |
| `'-0'` | aceito (`isNeg()` → `true`; `toFixed(2)` → `'0.00'`) |
| `' 12.5 '` | erro (espaços) |

→ **Validar por regex antes de construir**: `^(0|[1-9]\d*)\.\d{2}$` (PLAN §2.1) rejeita tudo acima. Para valores vindos do banco (já confiáveis) a mesma regex serve como asserção.

⚠️ RISCO — **zero negativo**: `new MoneyDecimal('-0.004').toFixed(2)` → `'-0.00'`. Acontece quando um valor negativo com mais de 2 casas é arredondado para zero. Com entrada validada (2 casas) e só add/subtract não aparece; se houver arredondamento, normalize (`isZero() ? '0.00' : ...`). Atenção também a `isNeg()` em `-0` (retorna `true`): use `lt(0)` para "é negativo".

Link: [decimal.js API](https://mikemcl.github.io/decimal.js/) (seções *Configuration*, *clone*, *toFixed*, *Decimal constructor*)

---

## 2. pino + nestjs-pino

Versões atuais: `pino@10.4.0`, `pino-http@11.0.0`, `nestjs-pino@5.3.1` (peer: NestJS `^11.0.8 || ^12.0.2`, pino 10, pino-http 11; `engines.node >=22.12`).

### Setup
```ts
LoggerModule.forRootAsync({          // registrar UMA vez, só no módulo raiz (senão loga em dobro)
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    pinoHttp: {
      level: cfg.get('LOG_LEVEL', 'info'),          // nível por env
      genReqId: (req) => req.headers['x-correlation-id'] ?? randomUUID(),
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password'], censor: '[Redacted]' },
      formatters: { level: (label) => ({ level: label }) },  // "info" em vez de 30
    },
  }),
});
// main.ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
```
- Nos services, use o `Logger` de `@nestjs/common` (padrão Nest) ou `PinoLogger`/`@InjectPinoLogger(Ctx)` para API estilo pino.
- Saída padrão: uma linha JSON por evento em stdout, com `level`, `time`, `pid`, `hostname`, `msg` (`base` controla pid/hostname; `messageKey` o nome de `msg`).
- `err` passa pelo serializer padrão (`pino.stdSerializers.err`) → logue `{ err }`, não `error.message`.

### Redaction
- `redact: string[]` ou `{ paths, censor, remove }`. Paths: notação JS, `*` como curinga, colchetes para chaves com hífen (`req.headers["x-api-key"]`), **case sensitive**.
- `remove: true` apaga a chave em vez de substituir.
- Custo: ~2% sem curinga; curingas custam bem mais (~50% no benchmark da doc) → prefira paths explícitos.
- ⚠️ RISCO — "Path strings must not originate from user input" (os paths são compilados).
- ⚠️ RISCO — redaction é rede de segurança, não estratégia: o CHALLENGE §12 proíbe "payloads financeiros completos nos logs" → logue só IDs e campos escolhidos (`transactionId`, `kind`, `status`, `failureCode`), nunca o `body` inteiro da mensagem SQS.

### Child loggers e contexto
- `logger.child({ walletId, transactionId })` → todas as linhas do filho carregam os bindings (serializados uma vez, na criação). `child(bindings, { level, redact })` pode sobrescrever nível/redaction.
- `mixin()` na raiz: função síncrona chamada a cada log, cujo retorno é mesclado — pode ler um `AsyncLocalStorage`. Retorne objeto novo a cada chamada.
- **nestjs-pino já usa AsyncLocalStorage** por request HTTP: `this.logger.assign({ walletId })` adiciona campos a todos os logs seguintes da mesma request (`assignResponse: true` inclui no log de resposta).
- ⚠️ RISCO — **fora de HTTP não há contexto** (consumer SQS, worker de outbox, retry de `PENDING_REFERENCE`, cron). Use `runInContext(fn, { bindings: { correlationId, messageId } })` do nestjs-pino (v5) em cada mensagem, ou `microservice: true` (hooks pré-request só no NestJS 12; no 11 é ignorado com warning). Sem isso, `assign()` não tem efeito e os IDs exigidos pelo §12 somem dos logs assíncronos.
- `pinoHttp.autoLogging: false` desliga o log automático de request/response mas mantém o contexto; `exclude`/`forRoutes` para tirar `/health` e `/metrics` do log.

### Nível por env e saída
- `level` default `info`; ordem `trace(10) < debug(20) < info(30) < warn(40) < error(50) < fatal(60)`, `silent`.
- `pino.stdTimeFunctions.isoTime` dá timestamp legível, mas a doc avisa que formatar tempo no processo "will significantly impact logging performance" → mantenha epoch ms em prod.
- Destino assíncrono por padrão; `fatal` faz flush síncrono. Em shutdown chame `logger.flush()`.

Links: [pino API](https://getpino.io/#/docs/api) · [pino Redaction](https://getpino.io/#/docs/redaction) · [pino Child loggers](https://getpino.io/#/docs/child-loggers) · [nestjs-pino README](https://github.com/iamolegga/nestjs-pino)

---

## 3. Métricas Prometheus (prom-client → `@prometheus-io/client`)

⚠️ RISCO — **`prom-client` foi descontinuado**: `prom-client@15.1.3` (jun/2024) está marcado no npm como *"prom-client has been replaced by @prometheus-io/client"*. O pacote novo (`@prometheus-io/client@0.16.1`, ago/2026, repo `prometheus/client_js`) é a mesma lib virando subprojeto oficial do Prometheus. Breaking changes do 0.16: Node só `^22 || ^24 || >=26`, `MetricType` vira união de strings, `AggregatorRegistry` → `ClusterRegistry`, storage interno mudou (afeta só quem estende classes). A API de Counter/Gauge/Histogram/Registry é a mesma. Escolha: pacote novo (mantido) ou `prom-client@15.1.3` (estável, sem updates) — documente.

### Tipos
```ts
const registry = new Registry();
collectDefaultMetrics({ register: registry });

const txTotal = new Counter({
  name: 'wagering_transactions_total', help: 'Transações processadas por status',
  labelNames: ['kind', 'status'] as const, registers: [registry],
});
txTotal.inc({ kind: 'BET', status: 'PROCESSED' });

const outboxPending = new Gauge({
  name: 'wagering_outbox_pending_messages', help: '...', registers: [registry],
  async collect() { this.set(await countPending()); },   // function, não arrow (usa this)
});

const latency = new Histogram({
  name: 'wagering_processing_duration_seconds', help: '...',
  labelNames: ['kind'] as const, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
});
const end = latency.startTimer({ kind: 'BET' }); /* ... */ end();  // registra em segundos
```
- **Counter**: só sobe; reset ao reiniciar o processo (Prometheus trata com `rate()`).
- **Gauge**: `set/inc/dec`; para valores "lidos na hora" (outbox lag, pendentes) use `collect()` — roda a cada scrape. A doc desaconselha `setInterval`.
- **Histogram**: buckets default `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` (segundos, latência web). Helpers `linearBuckets(start, width, count)` / `exponentialBuckets(start, factor, count)`. Cada bucket é uma série → poucos buckets × poucos labels.
- `as const` em `labelNames` faz o TS rejeitar label inexistente.
- Séries com label só aparecem após a primeira observação → pré-inicialize as combinações conhecidas (`counter.inc({...}, 0)`; histogram tem `.zero({...})`). Recomendação oficial: "export a default value such as 0 for any time series you know may exist in advance".

### Registry e `/metrics`
```ts
@Get('metrics') @Header('Content-Type', registry.contentType)
metrics() { return registry.metrics(); }   // async → Promise<string>
```
- Use um `Registry` próprio (não o global) — evita "metric already registered" em testes e hot reload.
- `registry.setDefaultLabels({ service: 'wagering' })` para labels estáticos.
- Com várias instâncias, cada uma expõe seu `/metrics` e o Prometheus agrega; não use label com ID da instância além do que o Prometheus já adiciona (`instance`).

### Convenções de nome e cardinalidade (prometheus.io)
- `snake_case`, prefixo da aplicação (`wagering_`), **unidade base** no plural como sufixo (`_seconds`, `_bytes`), **`_total` em counters** (depois da unidade: `..._seconds_total`), razões 0–1 (não %).
- Não repetir nome do label no nome da métrica.
- Labels só com conjuntos **pequenos e fechados**: `kind` (5–6), `status` (5), `failure_code` (~11), `reason`. "Try to keep the cardinality of your metrics below 10"; "the vast majority of your metrics should have no labels".
- ⚠️ RISCO — **nunca** `walletId`, `transactionId`, `providerId` aberto, `messageId`, URL crua como label → explosão de séries. Esses IDs vão para o **log**, não para a métrica.

Mapeamento para o §12 do CHALLENGE (sugestão de nomes): `wagering_transactions_total{kind,status}`, `wagering_duplicates_total{source}`, `wagering_retries_total{reason}`, `wagering_dlq_messages_total`, `wagering_lock_conflicts_total{sqlstate}`, `wagering_outbox_lag_seconds` (gauge via collect), `wagering_processing_duration_seconds{kind}` (histogram), `wagering_reconciliation_divergences_total`.

Links: [client_js / prom-client README](https://github.com/prometheus/client_js) · [CHANGELOG 0.16 (rename)](https://github.com/prometheus/client_js/blob/master/CHANGELOG.md) · [npm prom-client (deprecated)](https://www.npmjs.com/package/prom-client) · [Prometheus — Metric and label naming](https://prometheus.io/docs/practices/naming/) · [Prometheus — Instrumentation (cardinalidade)](https://prometheus.io/docs/practices/instrumentation/) · [Histograms and summaries](https://prometheus.io/docs/practices/histograms/)

---

## 4. Compatibilidade com Bun

### Base de runtime (doc oficial do Bun)
- `node:async_hooks`: **`AsyncLocalStorage` implementado** (base do contexto do nestjs-pino) — mas Bun **não propaga** o contexto para eventos de `Worker`, `MessagePort`, `BroadcastChannel`. `createHook` é stub.
- `node:perf_hooks`: `monitorEventLoopDelay()` e `createHistogram()` **implementados**; `eventLoopUtilization()` é **stub que sempre retorna zeros**; Bun não emite entradas `gc`.
- `node:worker_threads`: parcial (ignora `resourceLimits`; alguns `execArgv`).

### pino no Bun
- Funciona escrevendo JSON em stdout (sem transport). Issues abertas:
  - [#6355 — pino mais lento no Bun que no Node](https://github.com/oven-sh/bun/issues/6355) (aberta; benchmark recente com Bun 1.3.13: ~175 ms vs ~30 ms no Node). Causa identificada: `process.stdout.write` como propriedade própria faz o sonic-boom achar que o stream foi "monkey-patched" e cair no caminho lento; correção proposta no PR #31538.
  - [#23062 — bun does not work with pino-pretty](https://github.com/oven-sh/bun/issues/23062) e [#10246 — compile error com pino-pretty](https://github.com/oven-sh/bun/issues/10246) (abertas).
- Transports (`pino.transport()`, inclusive `pino-pretty` como transport) rodam em **worker thread** via `thread-stream` → área mais frágil no Bun; bundling (`bun build`) exige empacotar `thread-stream/lib/worker.js` à parte ([doc de bundling do pino](https://getpino.io/#/docs/bundling)).
- ⚠️ RISCO — **recomendação**: em todos os ambientes, pino → stdout JSON puro, sem transport. Pretty em dev por pipe: `bun run start:dev | bunx pino-pretty`. Volume de log alto + issue #6355 = custo de CPU; mantenha `info` em prod e evite log por mensagem em nível info no hot path do teste de carga.
- `nestjs-pino` declara `engines.node >=22.12` — o Bun não bloqueia por `engines`; o que importa é `AsyncLocalStorage` (ok). Não achei issue específica nestjs-pino × Bun; validar com teste de integração que `assign()`/`runInContext` propagam IDs.

### prom-client / @prometheus-io/client no Bun
- Histórico: `collectDefaultMetrics()` derrubava a app no Bun com `NotImplementedError: perf_hooks.monitorEventLoopDelay` ([bun#9432](https://github.com/oven-sh/bun/issues/9432), [bun#17716](https://github.com/oven-sh/bun/issues/17716), [bun#18300](https://github.com/oven-sh/bun/issues/18300), [prom-client#570](https://github.com/siimon/prom-client/issues/570)). Resolvido dos dois lados: prom-client 15.1.2 passou a capturar o erro; Bun implementou a API ([bun#17650](https://github.com/oven-sh/bun/issues/17650) fechada em set/2025; houve regressão em 1.2.15 — [bun#20325](https://github.com/oven-sh/bun/issues/20325)).
- ⚠️ RISCO — **métricas default enganosas no Bun**: `eventLoopUtilization()` retorna zeros ([bun#34068](https://github.com/oven-sh/bun/issues/34068), aberta; fix no PR #32618) → as métricas de *event loop utilization* novas do `@prometheus-io/client` 0.16 vão reportar **0 silenciosamente**; métricas de GC ficam vazias (Bun não emite `gc`); `heapUsed` ≈ 0. Não use essas séries para diagnóstico/alertas; confie nas métricas de negócio e em `process_resident_memory_bytes`/CPU.
- ⚠️ RISCO — `@prometheus-io/client` declara `engines.node ^22 || ^24 || >=26` e não menciona Bun; não há issue de incompatibilidade, mas também não há suporte oficial. Counter/Gauge/Histogram/Registry são JS puro (sem APIs nativas) → baixo risco. Cubra `/metrics` com um teste de integração rodando em `bun test`.
- `ClusterRegistry`/worker aggregation dependem de `cluster`/`worker_threads` → evitar no Bun (não é necessário: escala é por múltiplas instâncias/containers).

Links: [Bun — Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat) · issues listadas acima.
