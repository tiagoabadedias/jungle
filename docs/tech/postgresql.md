# PostgreSQL — guia prático para o Wagering Processor

> Base: documentação oficial **PostgreSQL 18** (versão "Current", 18.6 em out/2026). Tudo aqui vale também para o 17, exceto onde marcado.
> Contexto: `docs/PLAN.md` §0 (lock pessimista na wallet + `CHECK balance >= 0` + `version`), §4 (inbox/outbox na mesma transação), §5 (garantias no schema).
> Convenção: **⚠️ RISCO** = algo que quebra correção financeira ou causa bug silencioso se ignorado.

---

## 1. Locks de linha: `FOR UPDATE`, `FOR SHARE`, `NOWAIT`, `SKIP LOCKED`

Sintaxe: `FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE } [OF tabela] [NOWAIT | SKIP LOCKED]`.

| Modo | Bloqueia | Uso típico |
|---|---|---|
| `FOR UPDATE` | todos os outros modos | lock da wallet antes de alterar saldo |
| `FOR NO KEY UPDATE` | tudo menos `FOR KEY SHARE` | `UPDATE` comum já pega este (não bloqueia inserts com FK apontando para a linha) |
| `FOR SHARE` | updates/deletes e `FOR [NO KEY] UPDATE` | ler a transação referenciada (BET) garantindo que ela não muda até o commit |
| `FOR KEY SHARE` | só `FOR UPDATE` | o que a checagem de FK usa por baixo |

Locks de linha **não bloqueiam `SELECT` simples** (MVCC).

- `NOWAIT`: erro imediato se a linha está travada → SQLSTATE `55P03 lock_not_available`.
- `SKIP LOCKED`: pula linhas travadas. A doc avisa: "provides an inconsistent view of the data" → **só para tabelas-fila** (outbox, retries), nunca para leitura de negócio.
- Com `LIMIT`, só as linhas retornadas são travadas (mas linhas puladas por `OFFSET` também são travadas).
- Não pode ser usado com `GROUP BY`, `DISTINCT`, agregações, `UNION`. Em CTE, o `FOR UPDATE` vai **dentro** do `WITH`.
- `FOR UPDATE`/`FOR SHARE` exige privilégio `UPDATE` na tabela (relevante para o REVOKE do §4).

```sql
-- lock por wallet (nunca global — restrição §5.6 do CHALLENGE)
SELECT id, balance, currency, version FROM wallets WHERE id = $1 FOR UPDATE;
```

### Comportamento em READ COMMITTED (padrão) — o "re-check"
Se a linha alvo foi alterada por outra transação concorrente, o segundo `UPDATE`/`DELETE`/`SELECT FOR UPDATE` **espera** o primeiro terminar. Se o primeiro commitar:
- linha deletada → é ignorada;
- linha atualizada → o `WHERE` é **reavaliado sobre a versão nova**; se ainda casa, a operação segue e "é a versão atualizada da linha que é travada e retornada".

Consequência prática: `SELECT ... FOR UPDATE` em READ COMMITTED sempre devolve o saldo **mais recente commitado** → o padrão lock → ler → calcular → update é correto. Por isso o PLAN usa READ COMMITTED + `FOR UPDATE`.

⚠️ RISCO — **`ORDER BY` + `FOR UPDATE` em READ COMMITTED pode devolver linhas fora de ordem** (a ordenação acontece antes do lock; se a coluna de ordenação muda durante a espera, o resultado sai "desordenado"). Para a outbox use ordem por coluna imutável (`id`/`occurred_at`), que não muda.

⚠️ RISCO — **deadlock (`40P01`)** se duas transações travam várias linhas em ordens diferentes. A doc recomenda: travar sempre na mesma ordem (ex.: `ORDER BY id`), pegar o lock mais forte primeiro, transações curtas, e retry em `40P01`. No fluxo do PLAN só há uma wallet por transação → baixo risco; mas se travar wallet **e** transação referenciada, fixe a ordem (sempre wallet primeiro).

### Quando usar REPEATABLE READ / SERIALIZABLE
- **REPEATABLE READ**: snapshot fixo da transação. Se tentar alterar/travar linha que outro commitou depois do início → `ERROR: could not serialize access due to concurrent update` (`40001`). A doc: "should abort the current transaction and retry the whole transaction from the beginning". Útil para relatórios consistentes (ex.: reconciliação saldo × ledger lendo várias tabelas no mesmo snapshot).
- **SERIALIZABLE**: igual a RR + detecção de anomalias via predicate locks (`SIReadLock`, não bloqueiam). Exige **retry genérico de `40001`** em toda transação. Útil quando não dá para expressar a invariante com lock de linha/constraint.
- Para o fluxo financeiro com lock explícito por wallet, READ COMMITTED basta; RR/SERIALIZABLE trariam retries extras sem ganho.

Links: [SELECT — The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) · [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) · [Explicit Locking (row locks, deadlocks)](https://www.postgresql.org/docs/current/explicit-locking.html)

---

## 2. Timeouts por transação

| Parâmetro | O que faz | Erro |
|---|---|---|
| `lock_timeout` | aborta o **statement** se esperar mais que X por **um** lock (tabela, linha, etc.) | `55P03` "canceling statement due to lock timeout" |
| `statement_timeout` | aborta qualquer statement que dure mais que X | `57014 query_canceled` |
| `idle_in_transaction_session_timeout` | **encerra a sessão** ociosa dentro de transação aberta (segura locks e bloqueia vacuum) | `25P03` (FATAL, conexão cai) |
| `transaction_timeout` (PG17+) | encerra a sessão se a transação inteira passar de X | sessão encerrada |

Unidade padrão: ms; `0` = desligado (default de todos). A doc desaconselha setar `lock_timeout`/`statement_timeout` no `postgresql.conf` (afeta todas as sessões). Prefira por role ou por transação:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';        -- vale só até COMMIT/ROLLBACK
SET LOCAL statement_timeout = '5s';
SELECT ... FROM wallets WHERE id = $1 FOR UPDATE;
...
COMMIT;
```

`SET LOCAL` fora de transação só gera WARNING e não tem efeito. Com pool de conexões, `SET` (sem LOCAL) "vaza" para o próximo uso da conexão → use `SET LOCAL` ou `ALTER ROLE app SET ...`.

- `lock_timeout >= statement_timeout` é inútil (o statement timeout dispara antes).
- ⚠️ RISCO: `57014` também é o código de **cancelamento manual** (`pg_cancel_backend`) — diferencie pela mensagem se precisar.
- ⚠️ RISCO: `55P03` vem tanto de `NOWAIT` quanto de `lock_timeout` → trate ambos como "conflito de lock, retryable" (e conte na métrica de conflitos de lock exigida no §12 do CHALLENGE).
- `idle_in_transaction_session_timeout` é a rede de segurança contra worker que morreu/travou entre `BEGIN` e `COMMIT` segurando o lock de uma wallet "quente".

Links: [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) · [SET / SET LOCAL](https://www.postgresql.org/docs/current/sql-set.html)

---

## 3. Constraints e SQLSTATE

```sql
balance numeric(19,2) NOT NULL CHECK (balance >= 0),
amount  numeric(19,2) NOT NULL CHECK (amount > 0),
UNIQUE (provider_id, external_transaction_id),
```

- **CHECK**: satisfeito se a expressão for `true` **ou `NULL`** → sempre combine com `NOT NULL`.
- **UNIQUE**: por padrão NULLs são distintos (vários NULL passam). `UNIQUE NULLS NOT DISTINCT` (PG15+) muda isso.
- **Partial unique index** — unicidade só para parte das linhas (não dá como constraint):
  ```sql
  -- no máximo uma reversão (REFUND/ROLLBACK) efetivada por transação referenciada
  CREATE UNIQUE INDEX ux_one_reversal ON wager_transactions (reference_transaction_id)
    WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
  ```
  ⚠️ RISCO: `INSERT ... ON CONFLICT` só usa o índice parcial como árbitro se repetir o predicado: `ON CONFLICT (reference_transaction_id) WHERE kind IN (...) AND status = 'PROCESSED'`. E o planner só usa índice parcial em consultas cujo `WHERE` implica o predicado literalmente (parâmetros `$1` não servem).
- **FK**: `RESTRICT` impede delete do pai e **não é deferível**; `NO ACTION` (default) checa no fim do statement (ou da transação se deferido). FK **não cria índice** na coluna que referencia → crie manualmente (`ledger.wallet_id`, `ledger.transaction_id`).
- **DEFERRABLE**: só `UNIQUE`, `PRIMARY KEY`, `REFERENCES`, `EXCLUDE`. `CHECK` e `NOT NULL` são **sempre imediatos**. `UNIQUE` não-deferível é checado **por linha, imediatamente**. Uso: `DEFERRABLE INITIALLY DEFERRED` + `SET CONSTRAINTS ALL IMMEDIATE` para forçar checagem antes do commit. Não é necessário no fluxo do PLAN (ordem de inserts é controlada).

### SQLSTATE a tratar na aplicação

| Código | Nome | Tratamento sugerido |
|---|---|---|
| `23505` | `unique_violation` | idempotência: reler pela chave → replay ou conflito (backstop do PLAN §4); usar `constraint` do erro para saber qual |
| `23514` | `check_violation` | ex.: saldo negativo → bug ou corrida; não deve acontecer com lock correto → logar + métrica |
| `23503` | `foreign_key_violation` | erro de dados/ordem |
| `23502` | `not_null_violation` | bug de mapeamento |
| `40001` | `serialization_failure` | retry da transação inteira (RR/SERIALIZABLE) |
| `40P01` | `deadlock_detected` | retry com backoff |
| `55P03` | `lock_not_available` | `NOWAIT`/`lock_timeout` → retry/conflito de lock |
| `57014` | `query_canceled` | `statement_timeout` → retryable (cuidado: pode ter sido cancelamento manual) |
| `25P03` | `idle_in_transaction_session_timeout` | conexão caiu; descartar conexão |
| `P0001` | `raise_exception` | default de `RAISE EXCEPTION` sem `ERRCODE` (ver §4) |

No `node-postgres` o erro traz `code`, `constraint`, `table`, `detail` — classifique por `code` + `constraint`, nunca por texto da mensagem.

⚠️ RISCO: após qualquer erro dentro de uma transação, ela fica abortada ("current transaction is aborted") até `ROLLBACK`. Para "tentar insert e tratar 23505" **dentro** da transação, use `SAVEPOINT` ou `INSERT ... ON CONFLICT DO NOTHING RETURNING`.

Links: [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) · [Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html) · [INSERT ... ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) · [SET CONSTRAINTS](https://www.postgresql.org/docs/current/sql-set-constraints.html) · [Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)

---

## 4. Imutabilidade do ledger (trigger + privilégios)

Restrição §5.5 do CHALLENGE: não sobrescrever nem excluir lançamentos — e deve estar **no banco**.

```sql
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';  -- 23001; sem ERRCODE seria P0001
END $$;

CREATE TRIGGER ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
```

- Triggers de `TRUNCATE` existem **apenas** `FOR EACH STATEMENT`; `TRUNCATE` **não dispara** triggers de `DELETE` por linha → o trigger de TRUNCATE é obrigatório.
- `ERRCODE` explícito facilita classificar o erro na app (sem ele: `P0001`).
- `down` da migration precisa `DROP TRIGGER` antes de `DROP TABLE` (ou `DROP TABLE` já remove — ok).

**Reforço por privilégio** (defesa em profundidade):
```sql
REVOKE UPDATE, DELETE, TRUNCATE ON wallet_ledger_entries FROM app_user;
GRANT SELECT, INSERT ON wallet_ledger_entries TO app_user;
```

⚠️ RISCO — **o dono da tabela ignora o REVOKE na prática** (pode se re-conceder) e pode `ALTER TABLE ... DISABLE TRIGGER` ou `SET session_replication_role = replica` (desliga triggers comuns). Portanto: a role da aplicação **não pode ser** a dona das tabelas / a role de migration / superuser. No docker-compose, crie `app_user` separado do `POSTGRES_USER` (via script em `/docker-entrypoint-initdb.d`) — ou documente a limitação se usar um só usuário.

⚠️ RISCO — com `REVOKE UPDATE`, a app **não consegue** `SELECT ... FOR UPDATE/SHARE` no ledger (exige privilégio UPDATE). Não deveria precisar; trave a wallet, não o ledger.

Links: [CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html) · [Errors and Messages (RAISE)](https://www.postgresql.org/docs/current/plpgsql-errors-and-messages.html) · [Privileges](https://www.postgresql.org/docs/current/ddl-priv.html) · [REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html)

---

## 5. `numeric(19,2)` para dinheiro

- `numeric` é exato em soma/subtração/multiplicação; a doc o recomenda "especially ... for storing monetary amounts". Mais lento que inteiros — irrelevante aqui.
- `numeric(19,2)`: até 17 dígitos inteiros + 2 decimais. Excedeu a parte inteira → **erro**.
- ⚠️ RISCO — **mais casas que o scale são ARREDONDADAS silenciosamente**, não rejeitadas: `'10.005'` vira `10.01` (numeric arredonda empates **para longe do zero**). Nunca confie no banco para validar escala: valide `^\d+\.\d{2}$` na borda (PLAN §2.1) e envie sempre string com exatamente 2 casas. Se a app precisar arredondar, use o mesmo modo (`ROUND_HALF_UP` no decimal.js equivale a "away from zero" para positivos e negativos).
- ⚠️ RISCO — **`NaN` é um valor válido de `numeric`** e a doc diz que NaN é "greater than all non-NaN values" → **`CHECK (balance >= 0)` aceita `NaN`**. `Infinity` só cabe em `numeric` sem precisão (então `numeric(19,2)` rejeita), mas NaN não é barrado pela precisão. Adicione `CHECK (balance <> 'NaN')` / `CHECK (amount <> 'NaN')` ou garanta que a regex de entrada impede (ela impede — mas o schema é que é avaliado).
- Evite o tipo `money` (depende de `lc_monetary`, sem moeda por linha).

### node-postgres (`pg`)
- `pg` sem parser registrado para um tipo devolve **string**; `numeric` (OID 1700) não tem parser padrão → chega como `"25.00"` (preserva escala). `int8`/`bigint` (OID 20) também volta como string (JS não representa 64 bits com segurança).
- MikroORM: `DecimalType` "by default maps to a JS string, as mapping it to number could result in precision lost" — mantenha string e converta em `Money.from` (PLAN §1).
- **Não** registre `types.setTypeParser(1700, parseFloat)` — reintroduz float.
- Parâmetros: envie string (`'25.00'`), nunca `number`.
- Somatórios no SQL (`SUM(amount)`) retornam `numeric` sem scale fixo → normalize com `toFixed(2)` na app ou `::numeric(19,2)` no SQL.

Links: [Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html) · [node-postgres — Data Types](https://node-postgres.com/features/types) · [pg-types](https://github.com/brianc/node-pg-types) · [MikroORM Custom Types (DecimalType)](https://mikro-orm.io/docs/custom-types)

---

## 6. Keyset pagination com `(created_at, id)`

`OFFSET` grande é ineficiente ("rows skipped by an OFFSET clause still have to be computed") e instável sob inserts. Keyset usa a última linha vista como cursor:

```sql
CREATE INDEX ix_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);

SELECT * FROM wallet_ledger_entries
WHERE wallet_id = $1
  AND (created_at, id) < ($2, $3)        -- comparação de linha, lexicográfica
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

- Comparação de row constructor: elementos comparados da esquerda para a direita, para no primeiro par diferente → casa exatamente com o índice composto.
- `id` é o desempate obrigatório (ORDER BY precisa ser **único**, senão páginas repetem/pulam linhas).
- Direções do `ORDER BY` precisam bater com o índice (todas DESC ou todas ASC).
- Cursor opaco para o cliente: base64 de `created_at` + `id`.

⚠️ RISCO — **precisão de timestamp**: `timestamptz` tem microssegundos; `pg` converte para `Date` JS (milissegundos) e **trunca** os micros. Um cursor montado a partir do `Date` pula/repete linhas. Soluções: gerar o cursor com `created_at::text` no SELECT, ou definir a coluna com `timestamptz(3)`, ou paginar só por um `id` monotônico (bigserial/UUIDv7).

Links: [LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html) · [Row Constructor Comparison](https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON) · [Indexes and ORDER BY](https://www.postgresql.org/docs/current/indexes-ordering.html)

---

## 7. Outbox e fila em tabela com `SKIP LOCKED`

Gravação: o `INSERT INTO outbox` acontece **na mesma transação** de wallet/ledger/inbox (PLAN §4). Publicação: worker separado.

```sql
-- worker (N instâncias em paralelo, sem se pisar)
BEGIN;
SET LOCAL lock_timeout = '1s';
SELECT id, event_type, payload FROM outbox
WHERE published_at IS NULL AND next_attempt_at <= now()
ORDER BY occurred_at, id
LIMIT 50
FOR UPDATE SKIP LOCKED;
-- publica no SQS ...
UPDATE outbox SET published_at = now() WHERE id = ANY($1);           -- sucesso
UPDATE outbox SET attempts = attempts + 1, next_attempt_at = $2 WHERE id = $3;  -- falha (backoff)
COMMIT;

CREATE INDEX ix_outbox_pending ON outbox (occurred_at, id) WHERE published_at IS NULL;
```

- Dois publishers concorrentes nunca pegam a mesma linha enquanto o lock existir (cenário §13 "dois publishers sobre a mesma outbox").
- Se o processo morrer, a transação aborta, o lock some, outra instância pega → **at-least-once**: consumidores precisam deduplicar por `event id` (o CHALLENGE já assume eventos duplicados).
- ⚠️ RISCO — publicar no SQS **dentro** da transação segura o lock durante I/O de rede. Mantenha lote pequeno + `statement_timeout`/`idle_in_transaction_session_timeout`. Alternativa ("lease"): numa transação curta marcar `locked_until = now() + 30s` e commitar; publicar fora; depois marcar `published_at`. Mais robusto a SQS lento, mas exige lidar com lease expirado.
- ⚠️ RISCO — a ordem global não é garantida com SKIP LOCKED + vários workers (linhas puladas saem depois). Se ordem por agregado importar, use SQS FIFO com `MessageGroupId = walletId` + versão no payload — mas o CHALLENGE proíbe depender só de FIFO.
- Mesmo padrão serve para a **fila de reprocessamento de `PENDING_REFERENCE`** (`next_attempt_at`, `attempts`, índice parcial `WHERE status = 'PENDING_REFERENCE'`).
- Métrica de outbox lag: `now() - min(occurred_at) WHERE published_at IS NULL` (barata com o índice parcial).

Links: [SELECT — Locking Clause / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

---

## 8. Docker: imagem oficial `postgres` + healthcheck

```yaml
services:
  postgres:
    image: postgres:18-alpine          # fixe o major; 18.x é o atual
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}   # obrigatório, via .env (nunca hardcoded)
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql            # PG18+
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
  app:
    depends_on:
      postgres:
        condition: service_healthy   # forma curta NÃO espera o healthy
volumes:
  pgdata:
```

- `pg_isready` exit codes: `0` aceitando, `1` rejeitando (startup), `2` sem resposta, `3` parâmetros inválidos. Não valida senha nem existência do banco.
- `/docker-entrypoint-initdb.d` (`*.sql`, `*.sql.gz`, `*.sh`) roda **só com data dir vazio**; se o script falhar e o container reiniciar, não roda de novo → `docker compose down -v` para recriar.
- ⚠️ RISCO — **healthcheck verde antes da hora**: durante o init o entrypoint sobe um servidor temporário com `listen_addresses=''` (só socket Unix). `pg_isready` sem `-h` usa o socket e responde OK **enquanto os scripts de init ainda rodam**. Use `-h 127.0.0.1` (TCP) para só ficar healthy no servidor definitivo.
- ⚠️ RISCO — **caminho do volume mudou no PG18**: `PGDATA` agora é `/var/lib/postgresql/18/docker` e o volume declarado é `/var/lib/postgresql`. Montar em `/var/lib/postgresql/data` (padrão até o 17) não persiste como esperado. Para ≤17 continua `/var/lib/postgresql/data`.
- `$$` no compose escapa `$` para a variável ser expandida dentro do container.
- Migrations rodam pela aplicação/CLI do ORM, não por `initdb.d` (initdb.d só para roles/extensões).

Links: [Docker Hub — postgres](https://hub.docker.com/_/postgres) · [pg_isready](https://www.postgresql.org/docs/current/app-pg-isready.html) · [Compose healthcheck / depends_on](https://docs.docker.com/reference/compose-file/services/#healthcheck) · [docker-entrypoint.sh (listen_addresses='')](https://github.com/docker-library/postgres/blob/master/18/bookworm/docker-entrypoint.sh)
