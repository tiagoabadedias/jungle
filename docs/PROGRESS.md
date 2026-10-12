# Registro de Progresso

> Diário de execução do `docs/PLAN.md`. Cada entrada: o que foi feito, decisões, problemas e próximos passos.

## Status geral

| Fase | Status |
|---|---|
| Análise do desafio | ✅ concluída |
| Planejamento (`docs/PLAN.md`) | ✅ concluído |
| Pesquisa de boas práticas (`docs/tech/`) | ✅ concluída |
| 0. Spike de toolchain | ✅ concluída (pendente: Dockerfile + `docker stop`, movido para a Fase 3) |
| 1. Domínio puro | ✅ concluída |
| 2. Schema | ✅ concluída |
| 3. Use cases + HTTP | ✅ concluída |
| 4. Mensageria | ✅ concluída |
| 5. Observabilidade | ✅ concluída |
| 6. Concorrência e falhas | ✅ concluída |
| 7. Documentação | ✅ concluída |
| 8. Carga (opcional) | ✅ concluída |

---

## 2026-10-09 — Análise e planejamento
- Lido o desafio (`docs/CHALLENGE.md`).
- Decisões: MikroORM, `SELECT … FOR UPDATE` + CHECK no schema, auth via guard no-op documentado, MiniStack (fallback LocalStack).
- Plano revisado contra os requisitos; interpretações de lacunas registradas em `docs/PLAN.md` §10.

## 2026-10-10 — Fase 0 (spike de toolchain)
- Pesquisa de boas práticas disparada para: Bun/TS, NestJS, MikroORM, SQS/MiniStack, PostgreSQL, decimal.js/pino/prom-client → `docs/tech/`.
- Ambiente: Docker 24.0.2, Compose v2.19.1, Node 22. **Bun não instalado** → instalado Bun 1.4.2 via instalador oficial em `~/.bun` (sem sudo).

### Pesquisa (`docs/tech/`)
Guias escritos a partir da documentação oficial: `bun-typescript.md`, `nestjs.md`, `mikro-orm.md`, `sqs-ministack.md`, `postgresql.md`, `money-observability.md`.
Os ajustes de implementação que eles motivaram estão consolidados em `docs/PLAN.md` §0.1.

### Spike — o que foi criado
- `package.json` (ESM, `packageManager: bun@1.4.2`), `tsconfig.json` (strict, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, decorators inline), `bunfig.toml` (preload `reflect-metadata`, coverage ≥ 80%).
- `docker-compose.yml`: `postgres:18.6` (porta host **55432**, a 5432 já estava ocupada na máquina) e `ministackorg/ministack:1.5.24`.
- `infra/ministack/ready.d/01-sqs.sh`: cria `wager-transactions.fifo` (RedrivePolicy → DLQ, `maxReceiveCount=5`), `wager-transactions-dlq.fifo` e `wallet-events.fifo`.
- App mínima: `src/main.ts`, `src/app.module.ts`, `GET /health/live`, log de shutdown via `OnApplicationShutdown`.
- Testes do spike em `test/spike/` (descartáveis; tabela própria `spike_probe`, migrations em `test/spike/migrations`).

### Spike — resultados (`bun run test:spike` → 14 pass, `bun run typecheck` → ok)
| Item | Resultado |
|---|---|
| NestJS 12 sob `bun test`: DI por classe, token Symbol, `Reflector` em guard, `ValidationPipe` (rejeita `1e3` e campos extras) | ✅ |
| MikroORM 7 + `EntitySchema` sem decorators: migrations `.ts` up → down → up (programático) | ✅ |
| CLI `mikro-orm` rodando sob Bun (`bun run orm …`), `migration:create --blank` | ✅ |
| `numeric(19,2)` volta como **string** (`"0.30"`) | ✅ |
| `ON CONFLICT DO NOTHING` → `affectedRows = 0` na duplicata | ✅ |
| Unique violation num savepoint não aborta a transação externa | ✅ |
| `CHECK` do schema rejeita negativo | ✅ |
| `SET LOCAL lock_timeout` + `FOR UPDATE` concorrente → `DriverException` com `code = 55P03` | ✅ |
| SQS FIFO no MiniStack: filas do init script, dedup por `MessageDeduplicationId`, `ApproximateReceiveCount`, visibilidade 0, redrive para DLQ FIFO | ✅ |
| 3 instâncias via `Bun.spawn`, health ok, `SIGTERM` → shutdown gracioso, sem órfãos | ✅ |
| `tsc --noEmit` (TS 7) com strict + `exactOptionalPropertyTypes` limpo; `verbatimModuleSyntax` acusa TS1484 | ✅ |
| Threshold de coverage falha o comando (exit 1) | ✅ (só conta arquivos importados por testes) |

### Problemas encontrados e resolvidos
1. **Porta 5432 ocupada** → Postgres exposto em `55432`.
2. **Init script do MiniStack falhava com `InvalidClientTokenId`** e o container ficava *healthy* mesmo assim (risco 9 do guia, confirmado). Causa: o `aws` CLI da imagem **ignora `AWS_ENDPOINT_URL`** e mandava as chamadas para a AWS real. Correção: `--endpoint-url` explícito num wrapper; healthcheck agora também confere a existência da fila.
3. **`bunx` não carrega `.env`** → script `orm` usa `bun --env-file=.env --bun mikro-orm`.
4. `migration:create` gera `.snapshot-*.json` → ignorado no git; config real terá `snapshot: false`.

### Pendências levadas adiante
- Dockerfile da app (`oven/bun:1.4.2`, ENTRYPOINT em forma exec) + prova de `docker stop` gracioso → **Fase 3**, quando a app entrar no compose.
- Coverage só mede arquivos importados por testes → garantir que todo módulo de `src/` seja exercitado.
- Script `orm` depende de `--env-file=.env`; no container (env via Compose) e em CI o `.env` não existe → rodar migrations de forma programática/sem `--env-file` na **Fase 3**.
- `test/spike/` fica fora do `bun test` padrão (`pathIgnorePatterns`); roda só com `bun run test:spike`.
- Fase 1: `Money.from` aplica a regex ele mesmo (é a porta única de HTTP e SQS) e converte string ↔ `bigint` sem ponto flutuante.

## 2026-10-10 — Decisão: dinheiro em `bigint` (centavos)
- Pergunta do usuário: inteiro não seria o correto para dinheiro?
- Verificado no ambiente real (MikroORM 7 + PG 18 + Bun):
  - `numeric(19,2)` grava `25.005` como `25.01` (**arredondamento silencioso**);
  - `bigint` via MikroORM (`runtimeType: 'bigint'`) preserva valores acima de `Number.MAX_SAFE_INTEGER`;
  - `SUM`/aritmética SQL em `bigint` e `numeric` chegam como **string** pelo driver (nunca `number`);
  - `JSON.stringify` lança erro com `bigint` → dinheiro só sai pelo `Money.toJSON()`.
- **Decisão**: `bigint` em unidades menores no domínio e no banco (`*_minor bigint`), string `"25.00"` nas bordas, escala fixa 2 (§6.1). `decimal.js` removido. Detalhes e justificativa em `docs/PLAN.md` §2.1.
- Expoente por moeda (JPY/KWD) fica como extensão documentada — o §6.1 fixa escala 2 nos contratos.

## 2026-10-10 — Regra: sem commits
- **Nada é commitado nem enviado.** O projeto é apenas local, para desenvolver e testar. O repositório do desafio (clonado só para leitura em pasta temporária) nunca recebe commits. Registrado no `PLAN.md`.

### Próximo passo
**Fase 1 — Domínio puro**: `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, `IntegrationEvent` + subclasses, `FailureCode`, com testes unitários.

## 2026-10-10 — Fase 1 (domínio puro) — início
- Página de arquitetura com diagramas publicada (cópia local em `docs/architecture-overview.html`).
- Escopo: `Money` (bigint), `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, serviço de domínio `settleWagerTransaction` (regras do §7), `payloadHash`, `FailureCode`, `IntegrationEvent` + 4 eventos, `InboxMessage`, `OutboxMessage`, backoff exponencial.
- Decisão de desenho: as regras de BET/WIN/LOSS/REFUND/ROLLBACK ficam num serviço de domínio puro (`wagering/domain/wager-settlement.ts`), que recebe wallet, transação e referência já carregadas; o use case (Fase 3) só carrega, chama e persiste. Assim todo o §7 é testável sem banco.

## 2026-10-10 — Fase 1 (domínio puro) — concluída
**Arquivos (`src/`, TS puro, sem Nest/ORM):**
- `shared/domain/`: `money.ts` (bigint centavos), `currency.ts` (escala 2), `domain-error.ts`, `failure-code.ts` (taxonomia + ação do provedor), `exponential-backoff.ts`, `integration-event.ts`, `ports/clock.ts`, `ports/id-generator.ts`.
- `wallet/domain/`: `wallet.ts` (Aggregate Root), `wallet-ledger-entry.ts` (imutável, `Object.freeze`), `ledger-direction.ts`, `events/wallet-balance-changed.ts`.
- `wagering/domain/`: `wager-transaction.ts` (máquina de estados + `opening()` interno), `wager-settlement.ts` (regras do §7), `payload-hash.ts` (JSON canônico + SHA-256), kind/status, `events/wager-transaction-events.ts`.
- `messaging/domain/`: `inbox-message.ts`, `outbox-message.ts`.

**Testes (`test/unit/`, `bun run test:unit`): 161 pass, 0 fail · cobertura do domínio 100% linhas / 96,7% funções · `tsc` limpo.**
| Requisito do §13 (unidade) | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas (NaN, Infinity, 1e3, 25.005, hex, negativos…) | `shared/money.test.ts` |
| Invariantes da Wallet (saldo ≥ 0, version só muda com saldo, ledger junto) | `wallet/wallet.test.ts`, `wallet/wallet-ledger-entry.test.ts` |
| Regras BET, WIN, LOSS, REFUND, ROLLBACK (inclui reversão sem saldo, dupla reversão, fora de ordem, TTL) | `wagering/wager-settlement.test.ts` |
| Conflito de moeda | `money.test.ts`, `wallet.test.ts`, `wager-settlement.test.ts` |
| Idempotency key com payload divergente (hash muda) | `wagering/payload-hash.test.ts` |
| Guarda da regra eliminatória (sem parseFloat/Number/Math/+ unário no domínio) | `monetary-guard.test.ts` |

**Decisões tomadas durante a implementação** (registradas em `docs/PLAN.md` §10, itens 10–14): referência em BET/LOSS é payload inválido; `aggregateId` dos eventos é a wallet; backoff do domínio determinístico; consequência da reversão única após ROLLBACK de REFUND; referência vazia é payload inválido.

**Bug encontrado na revisão e corrigido:** `referenceExternalTransactionId: ""` passava pelo `create` e deixaria uma BET/WIN em `PENDING_REFERENCE` até o TTL. Agora é rejeitado; testes adicionados. A guarda monetária já cobre `persistence/`, `http/` e `sqs/` para as próximas fases.

**Restrições que o domínio impõe ao schema (Fase 2):**
- `observedBalance` está na moeda da **wallet**, não da transação (caso `CURRENCY_MISMATCH`): a coluna de snapshot precisa da sua própria moeda ou reidratar pela wallet.
- Unique parcial anti-dupla-reversão: `WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` (WIN também preenche `reference_transaction_id`).
- Trigger de imutabilidade: bloqueia UPDATE apenas quando `OLD.status` é terminal (permite `PENDING_REFERENCE → terminal` e reagendamento).
- Role da aplicação ≠ dona das tabelas: criar no `docker-entrypoint-initdb.d`; migrations rodam como owner.
- Fixtures de integração usam `crypto.randomUUID()` (o `UNIQUE(provider_id, external_transaction_id)` quebraria reexecuções com ids fixos).

### Próximo passo
**Fase 2 — Schema**: migrations escritas à mão (up/down) com todas as constraints, índices parciais e triggers; testes de constraint contra o PostgreSQL real.

## 2026-10-10 — Fase 2 (schema) — concluída
**Infra**
- `infra/postgres/initdb/01-roles-and-databases.sql`: role `wagering_app` (aplicação, **não** dona das tabelas) e banco `wagering_test`. Volume `jungle_pgdata` recriado para o script rodar.
- `.env` / `.env.test`: `DATABASE_URL` (app) e `DATABASE_MIGRATION_URL` (dona). O `bun test` carrega `.env.test` sozinho.
- `src/shared/infrastructure/database/mikro-orm.config.ts` (config única, migrations listadas em `migrations/index.ts`, `snapshot: false`) e `migrate.ts` (programático, sem CLI e sem `.env` — resolve a pendência do container).
- Scripts: `bun run db:migrate`, `db:migrate:down`, `test:integration`.

**Migration `Migration20261010000001InitialSchema`** (escrita à mão, `up` + `down`). Garantias no banco (§5.9):
| Garantia | Mecanismo |
|---|---|
| 1 wallet por player + moeda | `wallets_player_currency_uq` |
| Saldo ≥ 0 | `wallets_balance_non_negative_ck` |
| Idempotência | `wager_transactions_idempotency_key_uq`, `wager_transactions_provider_external_uq` |
| Reversão única (qualquer kind) | índice único parcial `wager_transactions_single_reversal_uq` (REFUND/ROLLBACK PROCESSED) |
| Forma da transação | CHECKs de kind, status (PENDING nunca persiste), valor (> 0, LOSS ≥ 0), referência obrigatória/permitida/não vazia, failure_code ↔ status, taxonomia de failure codes, agendamento de PENDING_REFERENCE, saldo observado com moeda própria |
| Terminais imutáveis, campos de negócio imutáveis, sem DELETE | trigger `wager_transactions_guard_trg` |
| 1 lançamento por transação por wallet | `wallet_ledger_entries_transaction_wallet_uq` |
| before ± amount = after; valores ≥ 0 | `wallet_ledger_entries_balanced_ck`, `..._amount_positive_ck`, `..._balances_non_negative_ck` |
| Lançamento na moeda e na wallet certas | FKs compostas `(wallet_id, currency)` → wallets e `(transaction_id, wallet_id)` → transações |
| Ledger append-only | triggers contra UPDATE/DELETE (linha) e TRUNCATE (statement) — valem até para a dona |
| Dedup de mensagens | `inbox_messages_pk (consumer_name, message_id)` |
| Outbox | tipos de evento conhecidos, payload objeto JSON, índice parcial de pendentes |
| Privilégios | `wagering_app`: sem DELETE, sem UPDATE no ledger, sem ALTER (não desliga triggers) |

**Testes de integração (Postgres real, `bun run test:integration`): 46 pass, 0 fail — reexecutáveis sem limpar o banco (ids aleatórios).**
- `schema/migrations.test.ts`: up → down → up; triggers instalados; todas as colunas `*_minor` são `bigint` e não existe `numeric/real/double/money`.
- `schema/constraints.test.ts`: cada constraint violada com o SQLSTATE e o nome esperados.
- `schema/privileges.test.ts`: a app é `wagering_app`, não superusuário, não desliga trigger, sem DELETE/UPDATE no ledger/ALTER.
- Unitários seguem 166 pass; spike 14 pass (agora usa a role dona, pois cria a própria tabela).

**Proteções adicionadas após revisão:** helpers de teste recusam qualquer banco ≠ `wagering_test` (variável exportada no shell venceria o `.env.test` e o teste de migration derrubaria o banco de dev); a migration cria `wagering_app` (nologin) se a role não existir, para os grants não falharem em outro Postgres.

**Armadilhas que o schema impõe à Fase 3 (anotadas para não esquecer):**
- `wager_transactions.updated_at` não existe no domínio: o mapper precisa de uma fonte determinística, e o repositório só persiste a transação que mudou — nunca a referência só lida. Senão um flush de linha terminal dispara o trigger e aborta a transação de negócio. Teste: "carregar uma PROCESSED como referência e dar flush não emite UPDATE".
- `23001` (restrict_violation) vindo dos triggers é erro de programação → HTTP 500 + métrica, nunca 409/422.
- `sum(bigint)` volta `numeric` (string) e `NULL` sem linhas: reconciliação usa `coalesce(sum(...), 0)` + `count(*)` e converte com `BigInt(...)`.

### Próximo passo
**Fase 3 — Use cases + API HTTP**: repositórios MikroORM (EntitySchema + mappers), `CreateWallet`, `ProcessWagerTransaction`, consultas, ledger com cursor, reconciliação, mapeamento de erros → HTTP; cenários 50× paralelo e 100/2×80 simultâneos contra o Postgres real; Dockerfile da app.

## 2026-10-10 — Fase 3 (use cases + HTTP) — início
- Persistência: `EntitySchema` sobre records + mappers (`rehydrate`); **escritas explícitas** (`em.insert` / `em.nativeUpdate`) — entidade só lida (ex.: a BET referenciada) nunca vira UPDATE, evitando o trigger de terminais.
- Porta `UnitOfWork`: abre a transação SQL com `SET LOCAL lock_timeout`, entrega repositórios ligados a ela; use cases não conhecem o MikroORM.

## 2026-10-10 — Fase 3 (use cases + HTTP) — concluída
**Aplicação** (`*/application/`): `CreateWallet`, `GetWallet`, `ListLedger`, `ReconcileWallet`, `ProcessWagerTransaction` (único para HTTP e SQS), `GetWagerTransaction`; portas de repositório; `UnitOfWork`; erros de aplicação (`InvalidRequest`, `WalletNotFound`, `IdempotencyConflict`, `TransientInfrastructure`, `UniqueViolation`…).

**Fluxo do `ProcessWagerTransaction`** (uma transação SQL): `SET LOCAL lock_timeout` → `SELECT wallet FOR UPDATE` → idempotência (key e (provider, id externo)) → `WagerTransaction.create` → referência → `settleWagerTransaction` → INSERT transação → INSERT ledger + UPDATE saldo (com checagem de version) → INSERT outbox → COMMIT. Violação de `UNIQUE` de idempotência (corrida entre wallets diferentes) → relê numa transação nova → replay ou 409.

**Infraestrutura**: EntitySchemas + mappers por contexto; leituras sem identity map e escritas explícitas (nada de UPDATE implícito); `MikroOrmUnitOfWork` traduz erros do driver (55P03/40P01/conexão → 503; unique → `UniqueViolationError` com o nome da constraint); config validada no boot; UUID v7; `ProviderAuthGuard` no-op + `ProviderIdentityPort` (§2).

**HTTP** (contrato igual em todos os endpoints): 201 aplicada / 202 aguardando referência / 400 payload inválido / 404 inexistente / 409 conflito / 422 regra de negócio (com `failureCode` e `retryable`) / 503 transitória (+`Retry-After`) / 500 bug (inclui `SCHEMA_GUARD_VIOLATION`). Replay = mesmo status e mesmo corpo + `idempotentReplay: true`. `X-Correlation-Id` recebido ou gerado e devolvido. Ledger com cursor opaco (base64url de `(createdAt, id)`).

**Docker**: `Dockerfile` (`oven/bun:1.4.2-slim`, multi-stage, usuário `bun`, ENTRYPOINT exec); compose com `migrate` (one-shot) → `app` (porta host **43180**: 3000 e 3100 já estavam ocupadas por outros projetos na máquina). `docker stop` → `SIGTERM` no PID 1 → shutdown gracioso, exit 0 em ~0,8 s ✅ (pendência da Fase 0 resolvida).

**Testes: 274 pass, 0 fail · cobertura geral 98,8% linhas / 94% funções · `tsc` limpo.**
| Requisito | Teste |
|---|---|
| Atomicidade wallet/transação/ledger/outbox | `integration/application/atomicity-and-transient.test.ts` (falha forçada na outbox desfaz tudo; retry processa uma vez) |
| Lock não obtido → 503, sem espera indefinida | idem (`lock_timeout` 200 ms) |
| 50× a mesma aposta em paralelo → 1 débito, 49 replays | `concurrency/http-concurrency.test.ts` |
| §8: 100.00 e 2×80.00 simultâneas (10 rodadas) → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito, retries sem duplicar | idem |
| Wallets distintas em paralelo; hot wallet com 60 operações mistas | idem |
| Mesma key em wallets diferentes ao mesmo tempo → `UNIQUE` decide, perdedora 409 | idem |
| Contrato HTTP, idempotência, replay, fluxos BET/WIN/LOSS/REFUND/ROLLBACK, consultas, cursor, reconciliação (divergência sinalizada e não corrigida) | `integration/http/*.test.ts` |
| Referência lida não é regravada (trigger de terminais não dispara) | `wagering.http.test.ts` |

**Bugs encontrados e corrigidos nesta fase**
1. O `export default` do config do MikroORM (só para a CLI) exigia `DATABASE_MIGRATION_URL` ao importar → a app quebrava no container. Separado em `mikro-orm.cli.config.ts` (CLI via `configPaths` no `package.json`).
2. NestJS 12 não aceita pipe em `@Headers(...)` → decorator próprio `@IdempotencyKey()`.

**Reforços após revisão:** `UniqueViolationError` inesperada (não-idempotência) → 500 `SCHEMA_GUARD_VIOLATION`, distinta de erro genérico; `providerId: "internal"` reservado → 400; `connectionTimeoutMillis` no pg.Pool (padrão do pg = espera infinita) → pool esgotado vira 503. Suíte: 279 pass.

**Armadilhas anotadas para a Fase 4:**
- Worker de `PENDING_REFERENCE`: `SKIP LOCKED` só para **reivindicar** ids; depois, por transação, travar **a wallet primeiro** e reler a linha com `status = 'PENDING_REFERENCE'` — mesma ordem de locks do HTTP, sem inversão (deadlock).
- Inbox: `TransactionScope` ganha `inbox`; o comando ganha `{consumerName, messageId, payloadHash}` opcional. Redelivery já processado é resolvido sem disputar o lock da wallet.
- `docker compose --scale app=3` não funciona com porta fixa no host: decidir na Fase 6 (sem porta nas réplicas ou nginx); o teste de 3 instâncias usa `Bun.spawn`.
- ARCHITECTURE.md: explicar por que os repositórios não usam o change tracking do Unit of Work (escritas explícitas evitam UPDATE implícito de linha terminal; provado pelo teste do `updated_at`).

**Fica para as próximas fases:** `saveState` e reprocessamento de `PENDING_REFERENCE` (worker, Fase 4); publicação da outbox e consumer SQS (Fase 4); métricas e logs pino (Fase 5); 3+ instâncias e crash (Fase 6).

### Próximo passo
**Fase 4 — Mensageria**: consumer SQS (mesmo use case + inbox), outbox publisher com `SKIP LOCKED`, worker de referências pendentes, DLQ, retry com backoff, shutdown gracioso.

## 2026-10-10 — Fase 4 (mensageria) — início
- Inbox no mesmo use case do HTTP: `INSERT … ON CONFLICT DO NOTHING` é o 1º passo da transação; redelivery já processada é resolvida sem disputar o lock da wallet.
- Outbox publisher: `FOR UPDATE SKIP LOCKED` → `SendMessageBatch` → marca publicado ou reagenda (backoff) na mesma transação.
- Worker de `PENDING_REFERENCE`: lista ids vencidos; por item, trava a wallet **primeiro** e relê a transação (mesma ordem de locks do HTTP).
- Consumer SQS próprio (o `sqs-consumer` não espera in-flight no `stop()`): negócio → ack; transitório → visibilidade com backoff; permanente → DLQ; limite de tentativas → DLQ; `SIGTERM` conclui o in-flight e devolve o resto.

## 2026-10-11 — Fase 4 (mensageria) — concluída
**Aplicação**
- `ProcessWagerTransaction` com inbox opcional: `tryReceive` (ON CONFLICT DO NOTHING) é o 1º passo da transação; `markProcessed` o último. Redelivery já processada → replay sem tocar no lock da wallet; mesmo `messageId` com outro conteúdo → `MessageConflictError` (permanente).
- `PublishOutboxUseCase`: `claimDue` (`FOR UPDATE SKIP LOCKED`) → publica → `markPublished` ou `scheduleRetry` (backoff), tudo na mesma transação.
- `ReprocessPendingReferencesUseCase`: lista ids vencidos; por item, trava a wallet primeiro, relê a transação e só segue se ainda pendente e vencida (outra instância pode ter tratado). Processada → `Processed` + `WalletBalanceChanged`; esgotada → `REJECTED REFERENCE_NOT_FOUND` + `Rejected`; reagendada → sem evento.

**Infraestrutura**
- `WagerTransactionsConsumer` (loop próprio, AWS SDK v3): long polling com `AbortController`; lote processado em ordem (FIFO); classificação: negócio → ack; permanente (`InvalidMessage`, `InvalidRequest`, `IdempotencyConflict`, `MessageConflict`, `WalletNotFound`, erros de domínio) → DLQ com `failureReason`; transitório → `ChangeMessageVisibility` com backoff por `ApproximateReceiveCount`; tentativas ≥ `SQS_MAX_ATTEMPTS` → DLQ `MAX_ATTEMPTS_EXCEEDED` (a RedrivePolicy é a rede de segurança). Ack só após o commit. `stop()` (SIGTERM): cancela o polling, conclui o in-flight e devolve o restante do lote com visibilidade 0. Ponto de falha `FAULT_INJECTION=after_commit_before_ack` para a Fase 6.
- `SqsEventPublisher`: `SendMessageBatch` (lotes de 10, falha parcial tratada), `MessageGroupId` = wallet, `MessageDeduplicationId` = eventId.
- `PollingWorker` genérico (drena backlog, dorme quando ocioso, `stop()` espera o tick).
- Módulos Nest: `SqsModule` (cliente + URLs das filas), `MessagingModule` (publisher), `WageringModule` (consumer + worker). Workers iniciam no `onApplicationBootstrap` e drenam no `beforeApplicationShutdown` (antes do pool fechar). Flags por env para ligar/desligar cada um; desligados no app dos testes HTTP.

**Testes (MiniStack + PostgreSQL reais, filas exclusivas por arquivo): suíte completa 305 pass, 0 fail · 99,5% linhas · estável em execuções repetidas.**
| Requisito | Teste |
|---|---|
| Inbox e redelivery (mesma mensagem 2× → 1 débito) | `messaging/consumer.test.ts` |
| Ack após commit; rejeição de negócio = ack (não DLQ) | idem |
| Permanentes → DLQ (JSON inválido, contrato, OPENING, conflito de idempotência, messageId reutilizado, wallet inexistente) | idem |
| Transitório → retry com backoff → processado uma vez; limite de tentativas → DLQ | idem |
| SIGTERM no meio do lote: conclui o in-flight, devolve o resto (visibilidade 0) | idem |
| Publicação após o commit (envelope, grupo, dedup) | `messaging/outbox-publisher.test.ts` |
| **Dois publishers sobre a mesma outbox** (interseção vazia; todos publicados) | idem |
| Broker fora → reagendado; crash depois de publicar e antes do commit → republicado | idem |
| **ROLLBACK/REFUND antes da referência** → worker aplica; TTL → `REFERENCE_NOT_FOUND`; dois workers → aplicado uma vez | `messaging/pending-references.test.ts` |
| Ponta a ponta no Docker: mensagem na fila real → processada (75.00) → 4 eventos publicados | smoke manual |

**Problemas de teste encontrados e resolvidos:** FIFO bloqueia o grupo enquanto há mensagem recebida e não apagada (helper agora consome o que lê); ordenação não total em consulta de teste causava flake (`order by occurred_at, id`).

**Reforços após revisão:** falha do SQS ao confirmar/reagendar uma mensagem não aborta o resto do lote (`handleSafely`); `ApproximateReceiveCount` malformado cai em 1 (não prende a mensagem); `FAULT_INJECTION` recusado com `NODE_ENV=production`; helpers de fila expõem os **nomes** e aceitam visibility timeout curto (preparação da Fase 6).

**Para o ARCHITECTURE.md:**
- Com `SKIP LOCKED` e vários publishers, dois eventos da mesma wallet podem sair fora da ordem de ocorrência no mesmo grupo FIFO. O §11 exige "sem perder nem duplicar indefinidamente", não ordem; `WalletBalanceChanged` carrega `walletVersion` para o consumidor ordenar.
- Eventos emitidos pelo worker usam `correlationId = idempotencyKey` (o correlationId original da requisição não é persistido na transação).

**Preparação da Fase 6:** processos filhos recebem por `env`: `SQS_CONSUMER_ENABLED=true`, `SQS_WAGER_QUEUE`/`SQS_WAGER_DLQ`/`SQS_EVENTS_QUEUE` (nomes das filas do teste), `DATABASE_URL`, `PORT` e, no teste de crash, `FAULT_INJECTION`. Fila de teste com visibility timeout curto (2–3 s).

### Próximo passo
**Fase 5 — Observabilidade**: logs pino JSON com `correlationId`/`messageId`/`transactionId`/`walletId`/`providerId` (AsyncLocalStorage), métricas (`@prometheus-io/client`), `/health/ready` (PostgreSQL + SQS).

## 2026-10-11 — Fase 5 (observabilidade) — concluída
**Logs** (`shared/infrastructure/observability/`)
- pino em JSON no stdout (sem transport, que trava o shutdown sob Bun); `PinoNestLogger` faz os logs do próprio NestJS saírem pelo pino (`bufferLogs` no boot).
- `AsyncLocalStorage` (`log-context.ts`): o `mixin` do pino injeta `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` em toda linha. Escopos: requisição HTTP (middleware), mensagem SQS (consumer), enriquecidos à medida que os ids ficam conhecidos.
- Redação de segurança (`money`, `amount`, `balance*`, `payload`, `body`, `data`, credenciais): o código não loga payloads, e o que escapar é censurado.
- Access log por requisição (método, rota, status, duração), exceto health/metrics.

**Métricas** (`@prometheus-io/client`, `GET /metrics`), labels sem ids:
| §12 exige | Métrica |
|---|---|
| transações por status | `wagering_transactions_total{status,kind,source}` |
| duplicatas detectadas | `wagering_duplicates_detected_total{kind=idempotent_replay\|idempotency_conflict\|message_conflict,source}` |
| retries | `wagering_retries_total{component,reason}` |
| mensagens em DLQ | `wagering_dlq_messages_total{reason}` |
| conflitos de lock | `wagering_lock_conflicts_total{sqlstate}` (55P03/40P01, via hook do UnitOfWork) |
| outbox lag | `wagering_outbox_lag_seconds` + `wagering_outbox_pending` (consultados a cada scrape) |
| latência de processamento | `wagering_processing_duration_seconds{source,outcome}` + `wagering_http_request_duration_seconds{method,route,status}` |
| extras | `wagering_outbox_published_total`, `wagering_pending_reference_outcomes_total`, `wagering_reconciliation_mismatches_total` (§9), `wagering_schema_guard_violations_total` |

Métricas padrão de processo ficam de fora: sob Bun, `eventLoopUtilization()` retorna sempre zero (oven-sh/bun#34068).

**Health**: `/health/live` (processo) e `/health/ready` (`select 1` + `GetQueueAttributes`, timeout 2 s cada; 503 durante o shutdown para o balanceador drenar). Sem autenticação.

**Testes: 322 pass (unit 197 · integração 120 · concorrência 5) + spike 14 · `tsc` limpo.**
- `unit/observability.test.ts`: ids do contexto em toda linha, contextos concorrentes não se misturam, redação de valores, adaptador Nest, métricas sem ids, outbox lag.
- `integration/http/observability.http.test.ts`: readiness real, 503 no shutdown, `/metrics` refletindo transações e rotas, lock preso → 503 + `Retry-After` + `wagering_lock_conflicts_total`.
- Docker: logs JSON com os ids, `/health/ready` up, métricas após uma aposta (4 eventos publicados, lag 0).

**Bug encontrado:** o registry chama o `collect` de cada métrica imediatamente antes de serializá-la; com a consulta no gauge errado, `outbox_pending` saía com o valor do scrape anterior. A consulta fica no primeiro gauge serializado e atualiza os dois (teste cobre).

**Reforços após revisão:** transações resolvidas pelo worker de referências entram em `wagering_transactions_total{source="worker"}` e deixam uma linha de log por transação (com os ids no contexto); o HTTP passa a logar `wager transaction handled` (kind, status, failureCode, idempotentReplay) como o SQS; falha no boot descarrega os logs em buffer (`Logger.flush()`) antes de sair.

**Armadilhas anotadas para a Fase 6:**
- Stdout dos processos filhos: com 3 instâncias logando por requisição, um pipe não drenado (64 KB) trava o filho. Rodar filhos com `LOG_LEVEL=warn` ou drenar continuamente.
- Crash depois do commit e antes do ack: provar com 1 débito, inbox com `processed_at`, fila de origem e DLQ vazias **e** `wagering_duplicates_detected_total{kind="idempotent_replay",source="sqs"} = 1` na instância sobrevivente (prova de que foi a deduplicação, não sorte).
- Reinício (§13 conc. 8): matar com `SIGKILL` no meio da carga, reiniciar e esperar o predicado "drenado" (fila vazia, outbox sem pendências, sem `PENDING_REFERENCE` com referência existente) antes do invariante global: `wallets.balance_minor = Σ ledger` para todas as wallets criadas no teste, numa única query.
- `docker compose --scale`: decidir na Fase 7 (perfil/arquivo sem porta fixa para réplicas); a prova do §13 é por `Bun.spawn`.

**Para o ARCHITECTURE.md:** métricas padrão de processo omitidas de propósito (Bun); `/metrics` sem autenticação, como `/health`.

### Próximo passo
**Fase 6 — Concorrência e falhas**: ≥ 3 processos (`Bun.spawn`) disputando a mesma wallet via HTTP e SQS; worker morto depois do commit e antes do ack (`FAULT_INJECTION`); reinício do serviço com comprovação da consistência final.

## 2026-10-11 — Fase 6 (concorrência e falhas com processos reais) — início
- Helper de cluster: instâncias reais (`bun src/main.ts`) via `Bun.spawn`, portas livres, filas exclusivas, workers ligados por env, stdout drenado continuamente (sem travar o filho), kill garantido no `afterAll`.

## 2026-10-11 — Fase 6 (concorrência e falhas com processos reais) — concluída
`test/concurrency/multi-instance.test.ts`: instâncias reais (`bun src/main.ts`) com pool, consumer e workers próprios, contra o mesmo PostgreSQL e filas exclusivas do teste. Invariante final verificado numa única consulta para todas as wallets do cenário (`balance = Σ ledger`, `version = 1 + movimentos`, saldo ≥ 0).

**Cobertura completa dos 8 cenários de concorrência do §13**
| §13 | Teste | Resultado |
|---|---|---|
| 1. mesma aposta 50× em paralelo | `http-concurrency` (1 processo) e `multi-instance` (50× espalhadas por 3 processos) | 1 débito, 49 replays |
| 2. disputa de saldo (§8) | idem, inclusive com as duas apostas em processos diferentes (10 rodadas) | 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito |
| 3. wallets distintas em paralelo | `http-concurrency`; `multi-instance` (15 wallets × 20 operações em 3 processos) | invariante ok |
| 4. ≥ 3 processos | `multi-instance`: HTTP em 3 processos; 3 consumers SQS + 3 publishers (com redeliveries e ROLLBACK antes da BET) | exatamente uma vez; DLQ vazia; todos os eventos publicados; ≥ 2 processos consumiram |
| 5. worker morto depois do commit e antes do ack | `multi-instance` (`FAULT_INJECTION` → SIGKILL) + sobrevivente | 1 débito, 1 linha na inbox, fila e DLQ vazias, `idempotent_replay{source="sqs"} = 1` no sobrevivente |
| 6. dois publishers na mesma outbox | `integration/messaging/outbox-publisher` | interseção vazia, todos publicados |
| 7. ROLLBACK/REFUND antes da referência | `integration/messaging/pending-references` e `multi-instance` | aplicado quando a referência chega; TTL → `REFERENCE_NOT_FOUND` |
| 8. reinício do serviço | `multi-instance`: SIGKILL nas 3 instâncias no meio de carga HTTP + SQS (prova de que havia trabalho pendente), 3 novas instâncias, provedor reenvia o que ficou sem resposta | saldos exatos (52.00 em todas as wallets), DLQ vazia, invariante global ok |
| extra: SIGTERM com mensagens em processamento | `multi-instance` | exit gracioso, outra instância conclui o restante, 40 débitos exatos |

**Bug encontrado na revisão e corrigido:** o status `FAILED` (§6.3) nunca era produzido, e o worker de referências podia travar inteiro: um item com erro inesperado fazia o `runOnce` lançar, e o próximo ciclo pegava o mesmo item primeiro, parando todas as outras pendências. Agora cada item é isolado: erro transitório → `DEFERRED` (volta no próximo ciclo); qualquer outro erro → `FAILED` com `INFRA_PERMANENT_FAILURE` (terminal, auditável, métrica `source="worker"`, log de erro) e o worker segue. Teste: item envenenado vira FAILED, o vizinho é processado, `runOnce` não lança. O §11 não define evento para FAILED, então nenhum é emitido (documentar).

**`docker stop` remedido com o consumer em long polling:** 224 ms, exit 0, log de shutdown (o `AbortController` cancela o long polling na hora).

**Suíte completa: 330 pass (unit 197 · integração 121 · concorrência 12), estável em execuções repetidas, sem processos órfãos.**

### Próximo passo
**Fase 7 — Documentação e entrega**:
- `docker compose --scale app=3`: gateway nginx na porta do host (com `resolver 127.0.0.11` para re-resolver as réplicas), `migrate` continua único; porta do Postgres via `${POSTGRES_PORT:-55432}`.
- Prova em máquina limpa: apagar o volume → `docker compose up -d --wait` → `bun install` → `bun run test`, cronometrado.
- Remover `test/spike/` (dominado por `multi-instance.test.ts`; o PROGRESS registra o que o spike provou).
- `README.md` (setup, `.env.example` → `.env`, `.env.test` versionado, comandos, endpoints, como reproduzir o invariante) e `ARCHITECTURE.md` (decisões, trade-offs, limitações e as 14 interpretações).

## 2026-10-11 — Fase 7 (documentação e entrega) — concluída
- **`docker compose up -d --scale app=3`**: app sem porta no host; gateway nginx (`${APP_PORT:-43180}`) com `resolver 127.0.0.11` + `proxy_pass` por variável (re-resolve as réplicas) e `proxy_next_upstream off` (nunca reenvia requisição financeira a outra réplica). Verificado: 30 apostas simultâneas distribuídas 9/14/7 entre 3 réplicas, reconciliação consistente. Porta do Postgres via `${POSTGRES_PORT:-55432}`.
- **`test/spike/` removido** (dominado por `multi-instance.test.ts`); o teste que conferia a DLQ FIFO do init script foi reescrito em `test/integration/messaging/queues.test.ts`.
- **Prova em máquina limpa** (`docker compose down -v` + `rm -rf node_modules`): `docker compose up -d --wait` 27 s → `bun install --frozen-lockfile` 1 s (cache) → `bun run test` 54 s → 330 pass.
- **`README.md`**: requisitos, subir o ambiente (inclusive `--scale`), portas e por quê, testes (comandos, `.env.test` versionado, tempos), API com exemplo, status HTTP, entrada por SQS, como verificar o invariante (endpoint + SQL global), observabilidade, configuração, estrutura. Os blocos de exemplo foram executados literalmente contra o stack.
- **`ARCHITECTURE.md`**: visão geral, MikroORM (e por que as escritas não usam o change tracking), dinheiro em bigint (com a evidência do `numeric`), concorrência e regra de ordem de locks, idempotência e algoritmo do hash, domínio e estados (quando `FAILED` acontece), códigos de falha, garantias no schema, mensageria (ordem de eventos, at-least-once, shutdown), autenticação não implementada e desenho previsto, observabilidade, as 14 interpretações, mapa §13 → testes, limitações, MiniStack × LocalStack.

**Suíte final: 335 pass, 0 fail · 99,3% linhas / 96% funções · `tsc` limpo.**

### Próximo passo
Fase 8 (opcional): teste de carga `bun run test:load` com relatório honesto (ambiente, metodologia, throughput, p50/p95/p99, erros, conflitos, outbox lag; ressalva: MiniStack não tem throttling).

## 2026-10-11 — Fase 8 (teste de carga) — concluída
- `bun run test:load` (`scripts/load-test.ts`): circuito fechado (32 VUs × 20 s) contra o gateway; cenários distribuído (200 wallets), hot wallet (1 wallet) e ingestão SQS (2000 mensagens); amostra `pg_locks` e a outbox a cada 250 ms e `docker stats` na metade de cada cenário; confere o invariante ao final (sai ≠ 0 se violado). Resultados brutos em `docs/load-test/*.json`; análise em `docs/LOAD_TEST.md`.
- **Resultados (rodadas isoladas):** 1 réplica: 435 req/s distribuído (p99 223 ms), 256 req/s hot wallet (p99 213 ms), 54,5 msg/s SQS. 3 réplicas: 278 / 142 / 56,9. 0% de erro, nenhum 503, invariante OK em 256 wallets nas duas configurações.
- **Achado honesto:** 3 réplicas renderam menos que 1 porque a VM Docker tem 4 CPUs e já satura com 1 réplica (app 119% + MiniStack 139% + Postgres 67%); o MiniStack (Python, processo único) limita publicação (~140 eventos/s) e ingestão (~55 msg/s). O ganho de escalar horizontalmente não pôde ser medido neste hardware — documentado, sem extrapolação.
- **Correção de metodologia durante a fase:** a 1ª rodada esperava só 60 s pela drenagem da outbox entre cenários e contaminou os seguintes (enqueue de 30 s vs 2 s); refeita com espera de até 5 min + `docker stats`.

## 2026-10-11 — Ambiente de demonstração (DigitalOcean) — preparado
Decisões do usuário: demo temporária para o avaliador, acesso por IP (sem domínio), **totalmente aberta** (sem lista de IPs, sem limite de requisições), **sem basic auth** (respeitar o §2: a API vai como entregue), ferramentas de inspeção públicas e somente leitura, expiração em **23/10/2026**.

**Arquivos novos (nada do que é avaliado mudou — verificado por data de modificação):**
- `docker-compose.demo.yml` (independente do de dev: override somaria as portas): Postgres e MiniStack sem porta pública; senhas geradas no deploy; 3 réplicas; restart, rotação de logs, `NODE_ENV=production`, `PERSIST_STATE=1`.
- `infra/demo/initdb/01-roles.sh`: `wagering_app` + `wagering_readonly` (só SELECT, read-only, `statement_timeout` 5 s, 5 conexões).
- `infra/demo/nginx.conf` + `gateway.conf.template`: :80 (página, API, `/docs`, health, métricas — sem filtro), :8081 pgweb, :8082 filas (só `GET` da inspeção do MiniStack, só as 3 filas), header `X-Demo-Environment`.
- `infra/demo/site/index.html` (página da demo) e `queues.html` (filas somente leitura, sem consumir).
- `scripts/deploy-demo.sh <ip> | --local` e `docs/DEPLOY.md`; `scripts/demo.ts` grava `demo.json` para a página.
- A troca do sqs-admin por página própria: no sqs-admin, ler mensagens e apagar/esvaziar filas usam o mesmo `POST`, e "ler" recebe a mensagem (atrapalharia o consumer).

**Verificado com `scripts/deploy-demo.sh --local`:** API/health/Swagger/métricas sem credenciais e com header; só o gateway publica portas; pgweb recusa escrita, corta consulta pesada em 5 s e trava a sessão; role de leitura recebe `permission denied` mesmo forçando escrita; filas lidas sem consumir (ReceiveCount inalterado após 10 leituras; consumer processou 5 mensagens normalmente durante leituras a cada 100 ms); POST, outras filas, outro host e outras rotas bloqueados.

**Problemas encontrados e corrigidos:** montagem do `openapi.yaml` dentro de pasta read-only; saída do template do nginx em diretório inexistente; `docker compose run -v` exige caminho absoluto; filtro de filas comparava o parâmetro ainda codificado.

**Teste instável encontrado:** com a demo local e a suíte rodando juntas na VM de 4 CPUs, o teste "SIGTERM no meio de um lote" estourou o prazo interno de 10 s esperando a 1ª mensagem. Sozinho passou 3/3; prazo de espera ampliado para 30 s (a asserção não mudou). Suíte completa: 335 pass.

### Próximo passo
Usuário cria o droplet (Docker on Ubuntu, 2 vCPU / 4 GB, chave SSH) e o Cloud Firewall (22, 80, 8081, 8082 abertos) e passa o IP → `scripts/deploy-demo.sh <ip>`.

## 2026-10-11 — Padronização das portas (arquitetura hexagonal)
- Convenção única: **portas em `<contexto>/application/ports/`, adaptadores em `<contexto>/infrastructure/`**; o domínio não tem portas (confirmado: nenhum arquivo de domínio importa `Clock`/`IdGenerator`).
- Movidos: `Clock` e `IdGenerator` (`shared/domain/ports` → `shared/application/ports`), `UnitOfWork` (`shared/application/` → `shared/application/ports/`), `ProviderIdentityPort` (`auth/` → `auth/application/ports/`), `ProviderAuthGuard` (`auth/` → `auth/infrastructure/http/`).
- Separados: `ReconciliationMonitor` saiu do arquivo do caso de uso para `wallet/application/ports/`; o adaptador `LoggingReconciliationMonitor` saiu do `wallet.module.ts` para `wallet/infrastructure/observability/`; o no-op `AnonymousProviderIdentity` saiu do arquivo da porta para `auth/infrastructure/`.
- Imports reescritos automaticamente (26 arquivos), sem mudança de lógica. `tsc` limpo; suíte completa 335 pass (os testes de integração sobem o `AppModule` inteiro, provando a injeção de dependências). Mapa porta → adaptador no `ARCHITECTURE.md` §1.

## Revisão de código — ondas 1 e 2 (2026-10-11)

Revisão geral (domínio, aplicação, infraestrutura, testes/infra) com os achados conferidos no código antes de mexer.

**Onda 1 (sem efeito no comportamento):**
- docs corrigidas: o worker de referências **não** usa `SKIP LOCKED` (lista sem lock e trava a wallet por item); a política de referências dá **~18,5 min**, não ~15 (ARCHITECTURE, PLAN);
- comentários enganosos corrigidos (InvariantViolationError, aggregateId/ordem no broker, INTERNAL_PROVIDER_ID, referência ao PLAN, publisher SQS, healthcheck, "Fase 6");
- código morto removido: `DuplicateKind`, `RetryComponent`, alias `CreateLedgerEntryProps`, campo `candidates`, `export` de `parseIdempotencyKey`. Mantidos `Money.negate`, `OutboxMessage.isDue`, `Wallet.debit/credit`: só os testes usam, mas cobrem invariantes;
- dependências sem uso removidas: `@mikro-orm/nestjs`, `supertest`, `@types/supertest`;
- `sqs-admin` fixado por digest; `.dockerignore` cobre `**/.env.*` e `infra/demo`; tabela de configuração do README completa.

**Onda 2 (correções, cada uma com teste):**
- consumer SQS: depois de uma mensagem reagendada, as seguintes do mesmo grupo FIFO no lote ficam retidas pelo mesmo tempo (`HELD_FOR_GROUP_ORDER`), sem passar à frente;
- logs: o `detail`/`hint` do PostgreSQL (linha inteira que falhou) é removido de mensagens, campos e stacks (`errorMessage`/`withoutDriverDetail` + logger);
- `translateError`: classes de SQLSTATE 08/53/57/58 e "Connection terminated" viram transitórias, então uma queda de conexão não marca mais uma transação como `FAILED`. Bug continua `FAILED`;
- `PollingWorker.stop()` tem prazo (5 s) e cabe no `stop_grace_period` de 30 s;
- guard repassa os headers à porta de identidade;
- testes: toda conexão da role da app passa pela checagem do banco `wagering_test`;
- menores: faixas de `SQS_WAIT_TIME_SECONDS` (1–20) e `SQS_MAX_MESSAGES` (1–10) no boot, backoff recusa `NaN`/fração, `Wallet.open` copia o `Date`, `saveState` usa o relógio do use case.

Resultado: typecheck limpo; **346 testes** (208 unit + 126 integração + 12 concorrência), antes 335; imagem reconstruída com `--frozen-lockfile`; `bun run demo` com 3 réplicas consistente.

## Documentação final (2026-10-11)
- **`README.md` reescrito como documento completo:**
  - sumário, visão geral com diagrama e índice de toda a documentação;
  - início rápido, ferramentas e demo;
  - arquitetura em resumo (camadas e os quatro fluxos);
  - tabela **garantia → mecanismo → teste que prova**, cobrindo as 9 restrições invioláveis do §5 e o §6.5;
  - API, SQS, invariante, testes, observabilidade, configuração e limitações.
  - Os blocos de comando foram mantidos literalmente (já executados contra o stack).
- **Referência à página de estrutura** (`docs/architecture-overview.html` + versão publicada) no topo, no índice e nas seções de arquitetura e estrutura.
- **Página de estrutura atualizada e republicada no mesmo link:**
  - árvore de pastas real, com portas em `application/ports/` e `auth/`;
  - `Wallet.move`;
  - política de referências (~18,5 min) e erros transitórios no worker;
  - notas de ordem do grupo FIFO e dos eventos;
  - linha do `500` no contrato HTTP;
  - números finais.
- **ARCHITECTURE:** números finais (346 testes, 99,3% linhas, 96,2% funções) e consumer.test no mapa do §13.
- **Novo script `bun run test:coverage`**, que torna a medição de cobertura reproduzível.

## Auditoria de conformidade com o enunciado (2026-10-11)
Comparação seção por seção (§2–§14) com o código e os testes. Nenhuma falha eliminatória pendente; todos os métodos dos esqueletos do §6 existem.

**Lacuna encontrada e corrigida:** o §13 exige o invariante final em todos os testes.
- `consumer.test.ts`, `pending-references.test.ts` e `outbox-publisher.test.ts` conferiam saldo e débitos, mas não o saldo contra o ledger.
- `atomicity-and-transient.test.ts` só contava lançamentos.
- **Correção:** helper `assertLedgerInvariant(orm, walletIds)` em `test/helpers/database.ts`, que confere saldo = soma do ledger e `version = 1 + movimentos` numa consulta, restrito às wallets do teste. Ele roda no `afterEach` desses quatro arquivos; o harness registra as wallets que cria.
- **Prova de que o check não é vazio:** um teste temporário corrompeu o saldo de uma wallet e o helper acusou; o teste foi removido em seguida.

## Revisão de código — onda 3: refatorações (2026-10-12)
Sem mudança de comportamento. Cada passo foi validado com typecheck (inclusive `--noUnusedLocals`) e testes.

**Aplicação:**
- **A4:** `recordSettlementEffects` (`wagering/application/settlement-effects.ts`) concentra ledger, saldo, eventos e outbox de uma liquidação. É usado pela entrada (HTTP/SQS) e pelo worker de referências; antes eram duas cópias.
- **A5:** a aplicação não conhece mais nomes de constraints. A infraestrutura traduz para `UniqueViolationError.duplicate` (`WAGER_TRANSACTION` | `WALLET`), com teste do mapeamento.
- **A6:** `moneyFromInput` (`shared/application/money-input.ts`) substitui as duas cópias de `parseMoney`.
- **A14:** `ReconciliationReport` mora na porta `ReconciliationMonitor`; a porta não importa mais do use case.

**Infraestrutura:**
- **I6:** `wager-telemetry` saiu de `shared` para `wagering/infrastructure/observability`. O config usa um tipo estrutural; `shared` não importa mais de `wagering`, exceto no ponto de composição do `UnitOfWork`.
- **I9:** os ticks dos workers saíram dos módulos para `*/infrastructure/workers/`, e a consulta do outbox lag foi para `messaging/infrastructure/persistence/outbox-backlog.ts`. O `MessagingModule` a registra nas métricas.
- **I10:** o consumer SQS foi dividido em `wager-error-classification.ts`, `sqs-message-settler.ts` (ack, retry, DLQ, release, retenção por grupo) e o consumer em si, que caiu de ~350 para 202 linhas.
- **I11:** `toProcessCommand` e `logWagerHandled` são compartilhados pelo controller HTTP e pelo consumer.
- **I12:** `errorCodeOf` é o helper único de extração de `code`.
- **I13:** um só leitor de env (`requireEnv` no app-config) e padrões do pool únicos (`DATABASE_POOL_MAX_DEFAULT`, `DATABASE_CONNECTION_TIMEOUT_MS_DEFAULT`).
- **I14:** `BackgroundWorkersLifecycle` genérico, com uma subclasse fina por módulo (os hooks do Nest continuam em providers de classe).

**Testes:**
- **T7/T11:** `test/helpers/http-client.ts` (`HttpClient`, `wager()`), usado por `TestApp` e pelo cluster multi-instância.
- **T8:** um `holdWalletLock` no lugar de três cópias.
- **T9:** um `testSqsClient`. Os scripts `demo`/`load-test` ficaram como estão, de propósito: rodam sem `.env`, inclusive no deploy.
- **T10:** a verificação do invariante é a mesma em todos os testes (`assertLedgerInvariant`, agora também com saldo ≥ 0).

**Infra (T16):**
- **`docker-compose.common.yml`**, via `extends`, com o que é idêntico entre dev e demo.
- **Prova de equivalência:** `docker compose config` antes e depois deu **idêntico** no dev (com e sem o perfil `tools`) e equivalente na demo; a única diferença é a ordem de dois mounts com destinos distintos.
- **`infra/nginx/app-proxy.conf`**, com as rotas `/docs` e `/`, incluído pelos dois gateways.

**Bug encontrado no caminho e corrigido:** `wagering_outbox_pending` saía com o valor do scrape anterior.
- **Causa:** o registry do Prometheus serializa em paralelo, e o gauge era lido antes de a consulta voltar.
- **Por que passou despercebido:** o teste aceitava `0`.
- **Correção:** os dois gauges aguardam a mesma consulta em andamento.
- **Testes:** um teste unitário com I/O lento reproduz o bug, e o teste de integração exige pendentes > 0 com o publisher desligado.

**Validação:**
- 351 testes passaram (213 unit + 126 integração + 12 concorrência).
- Ambiente local reconstruído com 3 réplicas, `nginx -t` ok e `bun run demo` consistente.
- **Incidente de ambiente:** o disco do Mac encheu (1 GB livre), o Docker entrou em modo somente leitura e o Postgres parou de aceitar conexões. Depois de liberar espaço e reiniciar o Docker Desktop, ele voltou com um disco novo e vazio (`Docker.raw` recriado), então os volumes locais anteriores se perderam. O código não foi afetado.
- **Prova em máquina limpa, de quebra:** `docker compose --profile tools up -d --build --wait --scale app=3` do zero (imagens baixadas) em 3m45s.
- **Cobertura:** a lógica dos ticks, agora isolada em `*/infrastructure/workers/`, ganhou testes unitários (`test/unit/workers.test.ts`: métricas, retries e o que conta como progresso), além de `moneyFromInput`. Resultado: **354 testes, 99,52% das linhas e 96,90% das funções**, acima de antes da onda 3 (99,3% / 96,2%).
- **Demo local** (`scripts/deploy-demo.sh --local`) validada com o compose comum e o snippet do nginx: as 3 réplicas sobem; página, API, Swagger, `openapi.yaml`, métricas, readiness, pgweb e página de filas respondem 200; fila fora da lista responde 403; o header `X-Demo-Environment` está presente. Depois disso a demo foi parada, como estava.

## Página de estrutura servida pelo projeto (2026-10-12)
- **`docs/architecture-overview.html` virou documento HTML completo:** doctype, `charset=utf-8` e viewport.
- **Diagramas:** renderizados no navegador pelo mermaid (CDN, versão fixa 11.4.1).
- **Servida pelos gateways em `/arquitetura`:** local em `http://localhost:43180/arquitetura`, demo em `http://<IP>/arquitetura`, via `infra/nginx/app-proxy.conf`. Está no índice da página da demo, no README e no DEPLOY.
- **Três defeitos de renderização encontrados no Chrome headless e corrigidos:**
  - `<<Estereótipo>>` era lido como tag HTML (o modelo de domínio não renderizava);
  - `&quot;` dentro de rótulo entre colchetes quebrava o diagrama de Money;
  - os ids saíam de `Date.now()`, então diagramas renderizados no mesmo milissegundo colidiam no primeiro SVG; agora `deterministicIds: true`.
- **Resultado:** os 8 diagramas renderizam com ids `mermaid-0…7`, e a captura foi conferida.
