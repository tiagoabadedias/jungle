# Teste de carga

Diferencial opcional do §14. Comando: `bun run test:load` ([`scripts/load-test.ts`](../scripts/load-test.ts)). Os resultados brutos estão em [`docs/load-test/`](load-test/). O objetivo aqui não é um número de RPS (não há meta no desafio), e sim entender onde o sistema satura, o custo do lock por wallet e se a correção se mantém sob carga.

## Resumo

- **Correção:** nas duas configurações, 0% de erro, nenhum `503` e o invariante `wallet.balance == ledger` intacto nas 256 wallets tocadas (inclusive uma wallet que recebeu ~5 mil transações concorrentes).
- **Throughput:** ~435 transações/s com 1 réplica, em muitas wallets. Numa única wallet disputada, ~256/s, o teto do lock pessimista por wallet neste hardware.
- **3 réplicas renderam menos que 1** neste ambiente. A causa, medida, é CPU: tudo roda numa VM Docker de 4 CPUs, que já fica saturada com 1 réplica. Mais réplicas só somam competição por CPU e conexões. Isso não diz nada sobre escalabilidade horizontal em hosts separados (veja a análise).
- **Outbox lag** cresce durante a carga (até ~20 s) porque publicar no MiniStack (~140 eventos/s) é mais lento que gerar eventos (~2 por transação). Nada se perde: o backlog drena depois. O ritmo de drenagem é o mesmo com 1 ou 3 publishers, o que mostra que o limite é o emulador, não a aplicação.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M1, 8 núcleos, 8 GB, macOS 14.5 |
| Docker | 24.0.2, VM com **4 CPUs e 3,8 GB**, compartilhada por todos os containers |
| Containers | PostgreSQL 18.6, MiniStack 1.5.24, nginx (gateway), app × 1 ou × 3, mais as ferramentas ociosas do perfil `tools` |
| App | Bun 1.4.2, pool de 10 conexões por réplica, `LOG_LEVEL=info` (2 linhas de log por requisição), consumer, publisher e worker ligados em todas as réplicas |
| Gerador de carga | o próprio host (Bun), mesmo hardware: compete por CPU com o sistema testado |

## Metodologia

- **Circuito fechado:** 32 usuários virtuais; cada um envia a próxima requisição assim que recebe a resposta, por 20 s em cada cenário, contra o gateway (`POST /wagering/transactions`).
- **Mistura:** 80% BET e 20% WIN de `1.00`, mais 5% de reenvios idênticos (replays idempotentes). As wallets começam com saldo alto, para medir o caminho de escrita e não rejeições.
- **Antes da medição:** aquecimento com 50 requisições.
- **Isolamento:** cada cenário só começa depois que a outbox do anterior foi totalmente publicada. Uma primeira rodada sem esse isolamento contaminou os cenários seguintes e foi descartada (ver "Histórico").
- **Amostragem do banco a cada 250 ms:** transações esperando lock (`pg_locks` com `granted = false`) e a outbox (eventos pendentes e idade do mais antigo). A CPU por container (`docker stats`) é amostrada na metade de cada cenário.
- **Correção ao final:** consulta global do invariante sobre todas as wallets tocadas.
- **Cenários:**
  1. **Distribuído:** 200 wallets, sorteadas a cada requisição.
  2. **Hot wallet:** todos os usuários virtuais na mesma wallet.
  3. **Ingestão SQS:** 2000 mensagens em 50 grupos FIFO (wallets), do envio até a última transação gravada.
- **Erro** = resposta `5xx` ou falha de rede. `422` é rejeição de negócio e é contado à parte.

## Resultados

Rodadas isoladas, `docker compose up -d --scale app=N`:

| Cenário | Métrica | 1 réplica | 3 réplicas |
|---|---|---|---|
| **Distribuído** (200 wallets) | throughput | **434,9 req/s** | 277,9 req/s |
| | p50 / p95 / p99 / máx | 64,5 / 127,8 / 222,8 / 491,5 ms | 94,9 / 282,7 / 420,5 / 705,1 ms |
| | erros · 503 · 422 | 0% · 0 · 0 | 0% · 0 · 0 |
| | transações esperando lock (máx / média) | 1 / 0,1 | 4 / 0,8 |
| | outbox: pendentes no pico · lag máx · drenagem após o fim | 15 514 · 19,1 s · 111 s | 10 404 · 19,8 s · 74 s |
| | CPU no meio da carga | app 119% · MiniStack 139% · Postgres 67% | apps 53+63+67% · MiniStack 79% · Postgres 74% |
| **Hot wallet** (1 wallet) | throughput | **255,8 req/s** | 142,3 req/s |
| | p50 / p95 / p99 / máx | 119,9 / 176,4 / 213,0 / 279,3 ms | 207,0 / 467,9 / 617,7 / 877,7 ms |
| | erros · 503 | 0% · 0 | 0% · 0 |
| | transações esperando lock (máx / média) | 9 / 7,6 | 27 / 22,0 |
| | outbox: pendentes no pico · lag máx · drenagem | 7 754 · 16,1 s · 53 s | 3 636 · 13,4 s · 27 s |
| **Ingestão SQS** (2000 mensagens, 50 grupos) | ponta a ponta | 36,7 s → **54,5 msg/s** | 35,2 s → **56,9 msg/s** |
| | outbox lag máx | 1,5 s | 0,4 s |
| **Correção** | wallets conferidas · violações do invariante | 256 · **0** | 256 · **0** |

Conflitos de concorrência: nenhuma requisição recebeu `503`, que é como um `lock_timeout` (5 s) se manifestaria ao provedor; portanto nenhum lock deixou de ser obtido a tempo. A disputa aparece como espera no lock (linha "transações esperando lock", amostrada em `pg_locks`) e como latência.

## Análise

**1. A CPU é o recurso saturado, e 3 réplicas pioram.** Com 1 réplica, app (119%), MiniStack (139%) e Postgres (67%) já somam ~3,3 das 4 CPUs da VM, sem contar o gerador de carga, que roda no host. Com 3 réplicas, o trabalho total é o mesmo ou maior, há mais processos e 30 conexões em vez de 10, e cada réplica tem o próprio consumer em long polling e o próprio publisher disputando o MiniStack. O resultado é menos throughput e cauda maior. A escalabilidade horizontal do desenho foi provada pela correção, nos testes de concorrência com 3 processos. Medir o *ganho* de vazão exigiria réplicas em hosts separados e um banco com CPU própria. Este ambiente não permite essa medição, e não vou extrapolar.

**2. Hot wallet: o custo previsto do lock por wallet.** Todas as escritas de uma wallet passam por um único `SELECT … FOR UPDATE`. A vazão de uma wallet é limitada pelo tempo de lock de cada transação (lock, idempotência, insert da transação, ledger, saldo, outbox e commit). Pelo throughput, esse tempo é **no máximo ~3,9 ms** com 1 réplica (1000 ms ÷ 256). É um limite superior: a VM estava saturada (app 72%, MiniStack 79%, Postgres 63%), então parte desse tempo é espera por CPU, não o lock em si. Com 1 réplica, o pool de 10 conexões limita quantas transações esperam no Postgres (~8). Com 3 réplicas, ~22 esperam ao mesmo tempo, e a fila no lock fica mais cara (trocas de contexto, CPU disputada): a vazão cai e o p99 sobe para ~620 ms. É o trade-off documentado no `ARCHITECTURE.md`: uma fila ordenada e correta por wallet, contra paralelismo. O lock otimista desperdiçaria trabalho em retries exatamente nesse cenário. A vazão total escala com o número de wallets diferentes (cenário distribuído: quase nenhuma espera por lock).

**3. Outbox lag: limite do emulador, não perda.** Cada transação gera 2 eventos (`WagerTransactionProcessed` e `WalletBalanceChanged`), cerca de 870 eventos/s no cenário distribuído com 1 réplica. A publicação no MiniStack sai a ~140 eventos/s, então a outbox acumula durante a carga e drena depois. O dado decisivo é o ritmo de drenagem após a carga: 15 514 ÷ 111 s ≈ 140/s com 1 publisher e 10 404 ÷ 74 s ≈ 140/s com 3 publishers em paralelo (no hot wallet, 146/s e 133/s). Triplicar os publishers não muda o ritmo, então o gargalo não é a aplicação, é o emulador. Com 3 réplicas a drenagem só termina antes porque acumulou menos backlog (menor throughput durante a carga). É o mecanismo previsto (§11): a outbox é um buffer durável, e o atraso afeta só a publicação, nunca o saldo nem a resposta ao provedor. No SQS real (300 TPS por fila FIFO por API, até 3 000 mensagens/s com batch, e mais com *high throughput FIFO*), o gargalo seria outro. Melhoria possível: enviar os lotes do `SendMessageBatch` em paralelo dentro de um mesmo ciclo do publisher.

**4. Ingestão SQS: o limite é o MiniStack.** ~55 mensagens/s com 1 ou 3 réplicas. Mais consumers não aumentam a vazão porque o emulador (Python, processo único) atende receive, delete e as publicações da outbox com ~1 núcleo (no hot wallet com 3 réplicas, ele chegou a 143% de CPU). O número mede o processamento ponta a ponta neste ambiente, não a capacidade do SQS nem da aplicação.

**5. O que fica de fora e as ressalvas.**
- O gerador roda na mesma máquina e disputa CPU.
- Os logs em `info` (duas linhas JSON por requisição) custam CPU. Não foram desligados, para medir a configuração real.
- 20 s por cenário não captura efeitos de longo prazo (crescimento de inbox/outbox, autovacuum).
- A variação entre rodadas é de ~15%: a primeira rodada distribuída com 1 réplica deu 514 req/s, contra 435 na rodada isolada.
- Os números servem para comparar cenários neste ambiente, não como capacidade de produção.

## Histórico

A primeira rodada esperava a drenagem da outbox por até 60 s. Com 3 réplicas, a drenagem não terminou nesse prazo, e o cenário seguinte rodou com o MiniStack ainda ocupado publicando o backlog: o envio de 2000 mensagens levou 30 s, contra 2 s isolado. A metodologia foi corrigida (espera de até 5 min pela outbox vazia entre cenários, mais `docker stats`), e as duas configurações foram medidas de novo. As tabelas acima são dessas rodadas isoladas.

## Como reproduzir

```bash
docker compose up -d --wait --scale app=1      # ou --scale app=3
bun run test:load                              # ~4–6 min; grava docs/load-test/<rótulo>-<data>.json
LOAD_LABEL=3-replicas LOAD_DURATION_S=30 LOAD_VUS=64 bun run test:load   # parâmetros ajustáveis
```

Variáveis: `LOAD_API_URL`, `LOAD_DURATION_S` (20), `LOAD_VUS` (32), `LOAD_WALLETS` (200), `LOAD_SQS_MESSAGES` (2000), `LOAD_LABEL`. O comando sai com código ≠ 0 se o invariante for violado.
