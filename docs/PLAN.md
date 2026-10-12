# Plano de Implementação — Distributed Wagering Processor

> Fonte da verdade: `docs/CHALLENGE.md` (citado como §N).
> Regra deste plano: **nada fora dos requisitos**. Onde o enunciado é omisso, a lacuna
> está listada na seção 10 ("Interpretações") com a justificativa — exigência do §7
> ("Qualquer interpretação adicional adotada deve ser documentada").

## 0. Decisões fechadas

| Tema | Decisão | Requisito |
|---|---|---|
| Runtime / pkg / testes | Bun 1.x (`bun install`, `bun test`) | §4 |
| Linguagem | TypeScript `strict: true` | §4 |
| Framework | NestJS | §4 |
| Banco | PostgreSQL, migrations versionadas **com `up` e `down`** | §4 |
| ORM | **MikroORM** | §4 (preferencial) |
| Mensageria | SQS via **MiniStack** (fallback LocalStack, ambos aceitos) | §4 |
| Orquestração | Docker Compose | §4 |
| Concorrência | `SELECT … FOR UPDATE` na wallet + `CHECK balance >= 0` + `version` | §5.6, §5.7, §8 |
| Auth | Não implementada: `ProviderAuthGuard` no-op + `ProviderIdentityPort` + desenho documentado | §2 |
| Representação do dinheiro | **`bigint` em unidades menores (centavos)** no domínio e no banco; string `"25.00"` só nas bordas (HTTP, SQS, eventos). Sem `decimal.js` | §5.1, §6, §6.1 — ver §2.1 |

### 0.1 Versões e ajustes de implementação (pesquisa `docs/tech/` + spike da Fase 0)

Não mudam o escopo, só o **como**, seguindo a documentação oficial de cada tecnologia:

| Tema | Ajuste | Fonte |
|---|---|---|
| Versões fixadas | Bun 1.4.2 · NestJS 12.1 (ESM) · MikroORM 7.2 (Kysely, sem knex) · PostgreSQL 18.6 · MiniStack 1.5.24 · TypeScript 7 | `docs/tech/*` |
| Idempotência (backstop) | No PG, um `23505` **aborta a transação**. O "captura e relê" do §4 roda num **savepoint** (`em.transactional` aninhado) ou numa transação nova | mikro-orm.md §5 · spike ✅ |
| Lock timeout | MikroORM 7 não tem `lockTimeout`: `SET LOCAL lock_timeout` por transação; erro `55P03` chega como `DriverException` com `.code` | mikro-orm.md §5 · spike ✅ |
| Inbox / dedup | `INSERT … ON CONFLICT DO NOTHING` via QB `.onConflict().ignore()` + `affectedRows === 0` | spike ✅ |
| Migrations | Escritas à mão (`migration:create --blank`), `down()` sempre implementado, `snapshot: false` (o diff automático apagaria triggers e índices parciais) | mikro-orm.md §7 |
| Schema | Dinheiro em `bigint` (sem `NaN` e sem arredondamento silencioso, que o `numeric` teria); trigger próprio contra `TRUNCATE` no ledger; **role da app ≠ dona das tabelas** (o dono pode desligar triggers) | postgresql.md |
| Cursor do ledger | O cursor carrega o `created_at` como texto vindo do banco (o `Date` do JS corta microssegundos e pula/repete linhas) | postgresql.md §6 |
| Contexto de log | `nestjs-cls` (AsyncLocalStorage) aberto por request HTTP, mensagem SQS e iteração de worker | nestjs.md §5 |
| Métricas | `@prometheus-io/client` (o `prom-client` foi descontinuado; mesma API) | money-observability.md |
| Consumer SQS | Loop próprio com `@aws-sdk/client-sqs` + `AbortController` no shutdown (`sqs-consumer` não espera in-flight no `stop()`) | sqs-ministack.md §5 |
| Workers | Loop próprio em todas as instâncias com `FOR UPDATE SKIP LOCKED` (o `@nestjs/schedule` não coordena instâncias) | nestjs.md §7 |
| Testes | `await request(...)` sempre (bug do supertest no `bun test`); `await expect(p).rejects`; unitários com `--parallel`, integração em série; `Bun.spawn` com kill no `afterAll` | bun-typescript.md |
| Execução | `bun src/main.ts` (nunca `bun build --compile` nem `nest start`); `tsc --noEmit` com `verbatimModuleSyntax` contra o bug de import de tipo do Bun | bun-typescript.md R1/R5 · spike ✅ |

## 1. Arquitetura

```
src/
  shared/        domain (Money, FailureCode, IntegrationEvent, portas Clock/IdGenerator) + infra (logger, métricas, config)
  wallet/        domain (Wallet, WalletLedgerEntry) · application (use cases, portas) · infrastructure (ORM, HTTP)
  wagering/      domain (WagerTransaction) · application (ProcessWagerTransaction…) · infrastructure (ORM, HTTP, SQS consumer, worker de referência)
  messaging/     domain (InboxMessage, OutboxMessage) · application · infrastructure (publisher SQS, worker outbox)
  health/  auth/  main.ts
migrations/   test/{unit,integration,concurrency,helpers}
```

- Domínio sem NestJS e sem tipos/decorators do ORM (§6.1).
- Persistência: `EntitySchema` do MikroORM sobre *records* + mappers que reconstroem via `rehydrate` (§6.0). `Money` persiste como `*_minor bigint` + `char(3)` (colunas separadas, permitido no §6.1); MikroORM `type: 'bigint', runtimeType: 'bigint'` devolve `bigint` nativo; agregações SQL (`SUM`) chegam como string e viram `BigInt(...)` — nunca `number` (§5.1).
- HTTP e SQS chamam **o mesmo use case** (§10).

## 2. Domínio (§6)

### 2.1 Money (§6.1)
- Construtor privado; `from`, `zero`, `fromMinorUnits` (reidratação), `add`, `subtract`, `negate`, `isZero/isPositive/isNegative/isLessThan/equals`, `toJSON`, `toString`, `minorUnits` (getter `bigint` para persistência).
- **Representação interna: `bigint` em unidades menores** (`"25.00"` ↔ `2500n`). O desafio só exige somar, subtrair, inverter sinal e comparar — não há multiplicação, divisão nem porcentagem (reversão parcial fora de escopo, §7.5) —, então inteiro é exato e suficiente.
- O esqueleto do §6.1 usa `Decimal`; trocamos por `bigint` amparados no §6 ("nomes e assinaturas podem ser adaptados, desde que as garantias sejam preservadas"). Motivos: sem arredondamento silencioso (o `numeric(19,2)` grava `25.005` como `25.01` — verificado), sem `NaN`, sem dependência externa (o `decimal.js` aceita `1e3`, `0x1A`, `Infinity`), padrão de mercado em ledgers (Stripe, Adyen, TigerBeetle, Money pattern).
- **Nunca `number`**: `number` inteiro continua sendo `number` (§5.1/§14). Proibidos em código monetário: `parseFloat`, `Number(`, `+valor`, `parseInt`, `Math.*`.
- Conversão manual na borda: a regex `^(0|[1-9]\d*)\.(\d{2})$` separa parte inteira e centavos → `BigInt(inteira) * 100n + BigInt(centavos)`. `toJSON` faz o inverso com `padStart`. Nenhum passo usa ponto flutuante.
- Escala: **fixa em 2 para todas as moedas** (§6.1 exige escala fixa 2 nos contratos), centralizada numa política de moeda (`MINOR_UNIT_SCALE = 2`). Expoente por moeda (JPY 0, KWD 3) exigiria mudar o contrato de entrada — fora de escopo, documentado como extensão no ARCHITECTURE.md.
- `bigint` não serializa em `JSON.stringify` (lança erro) → dinheiro só sai do domínio via `Money.toJSON()` (`MoneyProps` com string), o que é uma proteção extra.
- Imutável; serializa como string decimal com 2 casas.
- Rejeita: `NaN`, `Infinity`, notação científica, hex, separadores, string vazia, > 2 casas, negativos em contrato de entrada.
- Moedas diferentes → erro de domínio (`CurrencyMismatchError`). Multi-moeda no modelo, BRL nos cenários, conflito de moeda testado.

### 2.2 Wallet (§6.2)
- `open`, `rehydrate`, `debit`, `credit` (retornam o `WalletLedgerEntry` — saldo e ledger nascem juntos), `assertSameCurrency`.
- `version = 1` na criação; incrementa **somente** quando o saldo muda.
- Débito que deixaria saldo < 0 → erro de domínio.

### 2.3 WagerTransaction (§6.3) — transições válidas (a documentar)

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED  (ou permanece, reagendada)
PROCESSED / REJECTED / FAILED ──► (nenhuma) → InvalidTransactionStateError
```
- `create` valida exigência de referência por kind; `OPENING` só por caminho interno (§6.3).
- `affectsBalance()` false p/ LOSS; `requiresReference()` true p/ REFUND/ROLLBACK; `matchesPayload(hash)`; `ledgerDirectionFor(ref)`: BET→DEBIT; WIN/REFUND/OPENING→CREDIT; ROLLBACK→inverso da referência.

### 2.4 WalletLedgerEntry (§6.4)
- Sem campos mutáveis nem transições; `create` valida `balanceBefore ± money === balanceAfter`.
- ≤ 1 lançamento por transação por wallet; LOSS e REJECTED não geram lançamento.

### 2.5 Inbox / Outbox / IntegrationEvent (§6.5, §11)
- `InboxMessage(messageId, consumerName, payloadHash, receivedAt, processedAt)`.
- `OutboxMessage(id, aggregateId, eventType, payload, occurredAt, attempts, nextAttemptAt, publishedAt)` com `scheduleRetry` (backoff).
- `IntegrationEvent<T>` abstrata; subclasses com `eventType`/`version` no tipo: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`. `data` só com `MoneyProps`.

## 3. Regras de negócio (§7)

| Kind | Saldo | Ledger | Regra |
|---|---|---|---|
| BET | débito | 1 DEBIT | rejeita sem saldo (`INSUFFICIENT_FUNDS`) |
| WIN | crédito | 1 CREDIT | **pode** referenciar a BET da mesma rodada |
| LOSS | — | — | registra resultado |
| REFUND | crédito | 1 CREDIT | reverte BET `PROCESSED`, uma única vez |
| ROLLBACK | inverso | 1 invertida | reverte BET/WIN/REFUND `PROCESSED`, uma única vez |

Validação da referência (quando houver — obrigatória p/ REFUND/ROLLBACK, opcional p/ WIN), resolvida por `(providerId, referenceExternalTransactionId)`:

| Situação | Resultado | Regra |
|---|---|---|
| ausente | `PENDING_REFERENCE` (reprocessa depois) | §7.8 |
| provider/player/wallet/moeda/rodada divergente | REJECTED `REFERENCE_MISMATCH` | §7.2 |
| kind não permitido | REJECTED `INVALID_REFERENCE_KIND` | §7.3 |
| referência não `PROCESSED` | REJECTED `REFERENCE_NOT_PROCESSED` | §7 tabela ("reverte uma transação PROCESSED") |
| já revertida | REJECTED `REFERENCE_ALREADY_REVERSED` | §7.4 |
| valor diferente (REFUND/ROLLBACK) | REJECTED `REFERENCE_AMOUNT_MISMATCH` | §7.5 |
| reversão deixaria saldo negativo | REJECTED `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`) | §7.9 |

- REJECTED não altera saldo nem gera ledger (§7.6), mas é persistida e auditável.
- Replay retorna o resultado original, **incluindo o saldo observado naquele momento** (§7.7) → a transação guarda `balance_after_snapshot`.

### 3.1 Referência fora de ordem (§7.1)
- Worker agendado, backoff exponencial, limite de tentativas definido/justificado (proposta: 10 tentativas, `2s·2ⁿ` com teto 5 min ≈ 18,5 min; configurável).
- Esgotado → REJECTED `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

### 3.2 failureCodes (§7.2)
Taxonomia estável, com campo `retryable` para o provedor decidir: `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `INFRA_PERMANENT_FAILURE` (status `FAILED`). Documentada no ARCHITECTURE.md.

## 4. Fluxo transacional — commit, outbox e ack (§5.4, §6.5, §10, §11)

**Gravar** o evento na outbox ≠ **publicar** o evento. O requisito é:
- §6.5/§11: inbox, transação, saldo, ledger e **registro na tabela outbox** na **mesma transação SQL** — ou tudo é confirmado, ou nada.
- §5.4: **publicar** no broker só **depois do commit** → feito por um worker separado que lê a tabela outbox.
- §10: `ack` (delete da mensagem SQS) só **depois do commit**.

```
consumer/HTTP ─► BEGIN
                  1. inbox: INSERT (consumerName, messageId)         [só SQS]
                  2. SELECT wallet … FOR UPDATE                       (lock por wallet)
                  3. idempotência: busca por idempotency_key
                       existe + mesmo hash  → replay (resultado original)
                       existe + hash difer. → conflito
                  4. cria transação, resolve referência, aplica regra
                  5. UPDATE wallet (balance, version) + INSERT ledger  [se saldo muda]
                  6. INSERT outbox (eventos da §11)
                  7. inbox.processed_at
                 COMMIT
               ─► resposta HTTP  /  DeleteMessage (ack)  [após commit]

worker outbox ─► (depois, assíncrono) publica no SQS ─► marca published_at
```

- O lock da wallet vem antes da checagem de idempotência: as 50 duplicatas paralelas serializam e as 49 perdedoras leem a linha comitada → replay (§13 conc. 1). Backstop: `UNIQUE(idempotency_key)` no banco → captura violação, relê, devolve replay ou conflito.
- Morte **antes** do commit → rollback, nada persistido, mensagem volta a ficar visível → reprocesso.
- Morte **depois do commit e antes do ack** → redelivery → inbox já existe → ack sem efeito duplicado (§13 conc. 5).
- Morte **depois do commit e antes de publicar** → evento continua pendente na outbox → outra instância publica (§11 cenário 1–4).
- `POST /wallets` segue o mesmo padrão: wallet + OPENING + CREDIT + outbox numa única transação SQL (§9, §11).

### 4.1 Eventos emitidos (§11)
| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS (e OPENING) |
| `WagerTransactionRejected` | rejeição por regra de negócio (inclusive TTL de referência) |
| `WalletBalanceChanged` | **somente** quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

## 5. Schema — garantias no banco (§5.9)

Colunas monetárias: `bigint` em unidades menores (`balance_minor`, `amount_minor`, `balance_before_minor`, `balance_after_minor`, `balance_after_snapshot_minor`) + `currency char(3)` com `CHECK (currency ~ '^[A-Z]{3}$')`. Uma view de leitura (`*_minor / 100.0` formatado) pode ser criada só para inspeção humana — nunca usada pela aplicação.

**wallets**: `UNIQUE(player_id, currency)`, `CHECK(balance_minor >= 0)`, `CHECK(version >= 1)`.

**wager_transactions**: `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`; `CHECK` de kind/status; `CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`; `CHECK(status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)`; **unique parcial** de reversão sobre `reference_transaction_id` para REFUND/ROLLBACK `PROCESSED`; FKs para wallet e referência; trigger que impede UPDATE de linha em status terminal (imutabilidade de terminais, §6.3).

**wallet_ledger_entries**: `UNIQUE(transaction_id, wallet_id)`; `CHECK(amount_minor > 0)`; `CHECK(balance_before_minor >= 0 AND balance_after_minor >= 0)`; `CHECK` aritmético `balance_after_minor = balance_before_minor ± amount_minor` por direção; trigger `BEFORE UPDATE OR DELETE` + bloqueio de `TRUNCATE` (append-only, §5.5).

**inbox_messages**: `PK(consumer_name, message_id)`.

**outbox_messages**: índice parcial de pendentes `(next_attempt_at) WHERE published_at IS NULL`.

Testes de integração exercitam cada constraint e as migrations (up → down → up).

## 6. API HTTP (§9)

Endpoints exatamente como no enunciado:
`POST /wallets` · `GET /wallets/:walletId` · `GET /wallets/:walletId/ledger?cursor&limit` (cursor estável e opaco: keyset `(created_at, id)` em base64url) · `GET /wagering/transactions/:transactionId` · `GET /providers/:providerId/wagering/transactions/:externalTransactionId` · `POST /wagering/transactions` · `POST /wallets/:walletId/reconciliation` · `GET /health/live` · `GET /health/ready`.

**Status HTTP — consistente entre todos os endpoints (§9):**

| Situação | HTTP |
|---|---|
| Processada / wallet criada | 201 |
| Aceita com processamento pendente (PENDING_REFERENCE) | 202 |
| Payload inválido (inclui header `Idempotency-Key` ausente, kind `OPENING`) | 400 |
| Recurso inexistente | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeição por regra de negócio | 422 (`failureCode`, `transactionId`) |
| Falha transitória de infraestrutura | 503 |

- **Replay = mesma resposta** (§9: "requisição idêntica → mesma resposta"): mesmo status HTTP e mesmo corpo da resposta original, só com `idempotentReplay: true`.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas, campos ausentes omitidos) do subconjunto de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header e metadados de transporte fora (§9). Algoritmo documentado.
- Reconciliação: compara saldo armazenado com o reconstruído pelo ledger; divergência → log + métrica + `consistent: false`; **nunca corrige** (§9).
- Health sem auth (§2, §9).

## 7. Workers e SQS (§7.1, §10, §11)

**Consumer `wager-transactions.fifo`** (DLQ `wager-transactions-dlq.fifo`):
- Deduplica pela inbox `(consumerName, messageId)`; ack só após commit.
- Negócio (processada, rejeitada, pendente, replay) → ack.
- Transitório (DB/SQS indisponível, lock timeout) → não faz ack; `ChangeMessageVisibility` com backoff.
- Permanente (mensagem malformada, conflito de idempotência) → DLQ.
- Limite de tentativas antes da DLQ: `RedrivePolicy.maxReceiveCount` (proposta: 5).
- `SIGTERM`: para de buscar, conclui in-flight; o que não concluir → visibilidade devolvida (`ChangeMessageVisibility 0`).
- Transação vira `FAILED` (auditável) quando o erro é permanente de infra e a transação já existe (ex.: reprocessamento de referência que estoura limite por erro não-negócio).

**Outbox publisher**: `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT N` → publica → `published_at`; falha → `scheduleRetry`. Vários publishers concorrentes não pegam a mesma linha; crash após publicar e antes de marcar → republica (duplicata segura: `eventId` + `MessageDeduplicationId`).

**Pending-reference worker**: `FOR UPDATE SKIP LOCKED` sobre `PENDING_REFERENCE` vencidas → reentra no fluxo da seção 4.

## 8. Observabilidade (§12)
- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem dados sensíveis nem payload financeiro completo.
- Métricas (mínimo do §12): transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento (+ divergência de reconciliação, exigida no §9).
- `/health/live` e `/health/ready` (Postgres + SQS).

## 9. Testes (§13) — Postgres e MiniStack reais, sem mocks de infra

| Requisito | Teste |
|---|---|
| Money: escala, arredondamento (ex.: `0.10+0.20 = 0.30` exato, `"25.005"` rejeitado em vez de arredondado), inválidos, ida e volta string ↔ `bigint` (incl. valores > `Number.MAX_SAFE_INTEGER`) | unit |
| Guarda da regra eliminatória: teste que varre o código monetário e falha se encontrar `parseFloat`, `Number(`, `parseInt`, `Math.` ou `+` unário sobre valores | unit |
| Invariantes da Wallet; regras BET/WIN/LOSS/REFUND/ROLLBACK; conflito de moeda; key com payload divergente | unit |
| Migrations e constraints | integração |
| Atomicidade wallet/ledger/inbox/outbox | integração |
| Inbox e redelivery; retry e DLQ; publishers concorrentes; recuperação após reinício | integração |
| 50× a mesma aposta em paralelo → 1 débito | concorrência |
| 100.00 com 2×80.00 simultâneas → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito | concorrência |
| Wallets distintas em paralelo | concorrência |
| ≥ 3 instâncias simultâneas (3 processos via `Bun.spawn`) | concorrência |
| Worker morto depois do commit e antes do ack (ponto de falha injetável só em teste) | concorrência |
| Dois publishers sobre a mesma outbox | concorrência |
| ROLLBACK/REFUND antes da referência | concorrência |
| Reinício do serviço + consistência final | concorrência |

Invariante final em **todos** os testes: `wallet.balance == saldo reconstruído pelo ledger`.
Isolamento: cada teste usa IDs novos (wallet/player/provider) — sem limpar tabelas, preservando os triggers de imutabilidade.

## 10. Interpretações (lacunas do enunciado — irão para o ARCHITECTURE.md)

1. **Reversão única por referência, de qualquer kind** — *derivada do README*. §7.4 é uma proibição ("não pode ser revertida duas vezes pelo mesmo tipo"), não uma permissão para tipos diferentes. A tabela do §7 diz que REFUND e ROLLBACK revertem "uma única vez", e o §3 proíbe duplicar créditos; REFUND + ROLLBACK da mesma BET creditariam o valor duas vezes. A regra adotada satisfaz §7.4, a tabela do §7 e o §3 ao mesmo tempo. Schema: unique parcial em `reference_transaction_id` (REFUND/ROLLBACK `PROCESSED`).
2. **Wallet inexistente → 404**, sem persistir transação — *lacuna do README*. O §9 exige distinguir as situações de forma consistente entre endpoints; os GETs já usam 404 para recurso inexistente, então o POST segue o mesmo código. Não vira `REJECTED` porque a transação exige `walletId` válido (FK).
3. **Mesmo `(providerId, externalTransactionId)` com outra idempotency key → 409** (evita duplicata por chave alternativa; o §7.2 resolve referências por esse par, então ele precisa ser único).
4. **Valores** — *derivado do README*:
   - `Money` aceita `0.00` (o §6.1 só rejeita **negativos** em contratos de entrada; o §9 trata saldo inicial zero como válido).
   - **LOSS aceita `0.00` ou positivo** — não move saldo nem gera ledger (§6.4), então qualquer valor ≥ 0 é coerente.
   - **BET/WIN/REFUND/ROLLBACK com `0.00` → 400**: o §7 exige 1 lançamento no ledger para essas operações, e o §6.2 exige que todo lançamento corresponda a uma alteração de saldo ("e vice-versa") e que `version` só incremente quando o saldo muda. Um movimento zero não satisfaz as duas regras ao mesmo tempo, então é payload inválido.
   - OPENING só quando saldo inicial > 0 (§9).
5. **Referência existente mas ainda pendente** é tratada como ausente (`PENDING_REFERENCE`).
6. **WIN com referência** valida as mesmas regras de pertencimento e exige referência do tipo BET.
7. **Destino dos eventos publicados**: uma fila **SQS** (o §4 define SQS como a mensageria da stack; o §11 exige publicação, mas não nomeia o destino). Nome adotado: `wallet-events.fifo`, com `MessageDeduplicationId = eventId` como otimização — a segurança contra duplicata continua sendo o `eventId` no consumidor (§8, §11.5).
8. **Erro de conflito de idempotência vindo da fila → DLQ** (exige intervenção humana; não é rejeição de regra de negócio).
9. **Replay de transação que estava `PENDING_REFERENCE` e já foi resolvida** retorna o estado atual persistido.
10. **Referência só onde o README prevê** — REFUND/ROLLBACK (obrigatória) e WIN (opcional, §7). `referenceExternalTransactionId` em BET ou LOSS é **payload inválido (400)**, em vez de ser ignorado silenciosamente.
11. **`aggregateId` dos eventos = `walletId`** — a wallet é a unidade de concorrência (§8); todos os eventos de uma wallet compartilham o mesmo grupo FIFO na publicação. O `transactionId` vai em `data`.
12. **Backoff do domínio é determinístico** (`base · 2ⁿ`, com teto); jitter, se usado, é aplicado pelo worker na infraestrutura.
13. **Consequência da interpretação 1:** depois de BET → REFUND → ROLLBACK do REFUND, a BET continua contando como revertida (o REFUND segue `PROCESSED`), então ela não pode ser reembolsada de novo, mesmo com o efeito líquido restaurado. Leitura defensável de "uma única vez"; documentada no ARCHITECTURE.md.
14. **Referência vazia (`""` ou só espaços) é payload inválido (400)**, nunca tratada como "aguardando referência".

## 11. Fases

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0 | Spike: Bun + Nest + MikroORM + MiniStack | `bun test` sobe módulo Nest; migration up/down; FIFO + DLQ FIFO com RedrivePolicy no MiniStack |
| 1 | Domínio puro + testes unitários | §13 unidade verde |
| 2 | Migrations + constraints | testes de constraint verdes |
| 3 | Use cases + API HTTP | cenários 50× e 100/2×80 verdes |
| 4 | Inbox, outbox, consumer, DLQ, worker de referência, shutdown | testes de mensageria verdes |
| 5 | Logs, métricas, health | §12 coberto |
| 6 | Concorrência e falhas (3 instâncias, crash, restart) | §13 concorrência verde |
| 7 | README.md + ARCHITECTURE.md | §14 documentação |
| 8 | (opcional) `bun run test:load` | relatório com p50/p95/p99, erros, conflitos, outbox lag |
