# SQS FIFO + MiniStack — guia prático

> Escopo: consumer de `wager-transactions.fifo` (DLQ `wager-transactions-dlq.fifo`) e publicação de `wallet-events.fifo` pelo outbox worker. Base: CHALLENGE §10/§11 e PLAN §7.
> Fontes: docs oficiais da AWS, AWS SDK for JavaScript v3, README e código-fonte do MiniStack (`ministack/services/sqs.py`, v1.5.24, out/2026). Os comportamentos do MiniStack marcados com "(código)" foram conferidos lendo o código-fonte, não só o README.

---

## 1. SQS FIFO — o que importa

| Conceito | Regra | Fonte |
|---|---|---|
| `MessageGroupId` | **Obrigatório** em FIFO (sem ele o envio falha). A ordem é garantida **dentro do grupo**. Grupos diferentes são processados em paralelo e sem ordem entre si. Até 128 caracteres. | [FIFO delivery logic](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html), [MessageGroupId](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagegroupid-property.html) |
| `MessageDeduplicationId` | Mensagens com o mesmo id dentro da janela de dedup são aceitas, mas **só uma é entregue**. | [MessageDeduplicationId](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html) |
| `ContentBasedDeduplication` | Gera o id como SHA-256 do **body**, sem os atributos. Um id explícito tem precedência. Sem nenhum dos dois, o envio falha. | [SetQueueAttributes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html) |
| Janela de dedup | **5 minutos**, contados a partir do envio. Depois disso, o mesmo id é aceito de novo. | [Exactly-once processing](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html) |
| `DeduplicationScope` / `FifoThroughputLimit` | `messageGroup` + `perMessageGroupId` ativam o *high throughput*. | [High throughput FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html) |
| Throughput | Modo normal: **300 TPS por ação**, ou 3.000 msg/s com batch de 10. Em high throughput, até 70k TPS (us-east-1). | [Message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html) |
| In-flight | Máximo de **120.000** em FIFO. Ao atingir o limite, o SQS **não retorna erro**: as mensagens simplesmente deixam de chegar. | [FIFO quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html) |
| Visibility timeout | Padrão de 30 s, faixa de 0 a 43.200 s (12 h). | [Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) |
| Outros limites | `MaxNumberOfMessages` de 1 a 10. `WaitTimeSeconds` até 20. Mensagem de até 1 MiB. Retenção de 60 s a 14 dias (padrão: 4 dias). | [ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html) |

**Bloqueio do grupo enquanto há mensagem in-flight.** Um único receive pode trazer várias mensagens do mesmo grupo, em ordem. Enquanto alguma delas estiver invisível, nenhuma outra mensagem desse grupo é entregue a **nenhum** consumer, até ser deletada ou voltar a ficar visível. Por isso:
- Retry com `ChangeMessageVisibility(backoff)` **segura o grupo inteiro** durante o backoff. Isso é o comportamento desejado: preserva a ordem por wallet.
- Uma mensagem "venenosa" bloqueia o grupo até cair na DLQ, ou seja, até `maxReceiveCount` × tempo de visibilidade.
- Se o consumer recebe um lote de 10 mensagens do mesmo grupo e a 1ª falha, as seguintes **não podem** ser processadas fora de ordem. Devolva todas (visibilidade 0 ou o backoff) e não delete as posteriores.

**Escolha do grupo.** Use `MessageGroupId = walletId`: dá ordem por carteira e paralelismo entre carteiras. Use `MessageDeduplicationId = messageId` (ou o `eventId` no outbox). O id explícito é melhor que `ContentBasedDeduplication`, porque o body pode mudar (por exemplo, `occurredAt`) entre republicações.

> A dedup do SQS dura só 5 min. Ela **não substitui** a inbox `(consumerName, messageId)` nem a idempotência por `idempotencyKey`. Um outbox que republica após 5 min gera uma duplicata real.

**`ReceiveRequestAttemptId` (só FIFO).** Se o receive falhar na rede, repetir com o mesmo id devolve as mesmas mensagens e os mesmos receipt handles. O id vale por 5 min. Sem ele, um retry pode esperar o timeout de visibilidade original. Veja [ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html).

---

## 2. DLQ

```json
"RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"5\"}"
```

- **`maxReceiveCount`**: quantas vezes a mensagem pode ser recebida. Quando o `ReceiveCount` **excede** esse valor, ela vai para a DLQ. Faixa de 1 a 1000 (padrão 10). O atributo é uma **string JSON** dentro de `Attributes`. Veja [SetQueueAttributes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html).
- **A DLQ de uma fila FIFO precisa ser FIFO**, e a de uma fila standard precisa ser standard. As duas filas ficam na mesma conta e região. Fontes: [SetQueueAttributes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html), [DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).
- **`RedriveAllowPolicy`** é configurada na DLQ e define quem pode usá-la: `allowAll` (padrão), `denyAll` ou `byQueue` com até 10 `sourceQueueArns`. Exemplo: `{"redrivePermission":"byQueue","sourceQueueArns":["arn:...:wager-transactions.fifo"]}`.
- **`ApproximateReceiveCount`**: peça em `MessageSystemAttributeNames`. Serve para decidir o backoff (`attempt = receiveCount`) e para mandar à DLQ de forma explícita antes do limite.
- Em DLQ FIFO, o timestamp de enqueue **reseta** quando a mensagem é movida, então a retenção conta a partir da movimentação. A AWS alerta que usar DLQ em FIFO "quebra" a ordem exata do grupo: a mensagem sai da sequência e as seguintes avançam.
- **Erro permanente → DLQ.** O SQS não tem uma API do tipo "mover para a DLQ agora". Há duas opções:
  - (a) `SendMessage` na DLQ (com o mesmo `MessageGroupId` e um dedup id derivado) seguido de `DeleteMessage` na origem;
  - (b) deixar o `ReceiveCount` estourar.

  A opção (a) é determinística e não segura o grupo. Recomendada.
- Para levar mensagens da DLQ de volta à origem, use [DLQ redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html) (`StartMessageMoveTask`).

---

## 3. Consumer — chamadas e parâmetros

```ts
const res = await sqs.send(new ReceiveMessageCommand({
  QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60,
  MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'SentTimestamp'],
  MessageAttributeNames: ['All'],
  ReceiveRequestAttemptId: attemptId,            // FIFO: retry seguro do receive
}), { abortSignal: shutdown.signal });
```

- **Long polling** (`WaitTimeSeconds=20`) reduz respostas vazias e custo. O timeout HTTP do client precisa ser **maior** que `WaitTimeSeconds`. Veja [Short vs long polling](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html).
- **`AttributeNames` está deprecated.** Use `MessageSystemAttributeNames`. Veja [ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html).
- **`DeleteMessage(ReceiptHandle)`** é o ack. Chame **só depois do commit** no Postgres. Use sempre o receipt handle do **último** receive. Veja [DeleteMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessage.html).
- **`ChangeMessageVisibility`**:
  - **Backoff:** `VisibilityTimeout = min(base·2^(n-1) + jitter, teto)`, com `n = ApproximateReceiveCount`. O valor conta a partir da chamada e não é persistido: no próximo receive volta o timeout padrão.
  - **Heartbeat:** estenda a visibilidade se o processamento passar de ~50% do timeout. O máximo é de 12 h, e a AWS retorna erro se você pedir mais do que o tempo restante.
  - **Shutdown:** `VisibilityTimeout: 0` devolve a mensagem na hora. Atenção: isso **conta como um receive**, porque o `ReceiveCount` já foi incrementado. Shutdowns repetidos aproximam a mensagem da DLQ.
  - Fonte: [ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html).
- **SIGTERM** (veja [AbortController no SDK v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/abortcontroller.html)):
  1. `abort()` no long poll. A promise rejeita com `name === 'AbortError'`; trate isso como saída normal do loop.
  2. Pare de buscar mensagens novas.
  3. Aguarde as in-flight até um deadline menor que o `terminationGracePeriod` / `stop_grace_period`.
  4. Para o que não terminou e **não commitou**, chame `ChangeMessageVisibility 0`.
  5. Feche o client.
  - **Risco geral:** se o servidor já tinha separado mensagens quando o abort chegou, elas ficam invisíveis até o timeout. Nada se perde (é at-least-once), mas a entrega atrasa.
- **Múltiplas instâncias.** Funciona sem coordenação: o SQS entrega cada grupo a um consumer por vez. A inbox persistente cobre redelivery, timeout expirado durante o processamento e falha de rede no `DeleteMessage`.

---

## 4. AWS SDK v3 — `@aws-sdk/client-sqs`

```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT,            // ex.: http://ministack:4566 (omitir na AWS real)
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, // fake só no emulador; via env/IAM em prod
  maxAttempts: 3,                                // padrão "standard": 1 + 2 retries
  requestHandler: new NodeHttpHandler({ requestTimeout: 25_000 }), // > WaitTimeSeconds
});
```

- **Endpoint customizado.** Use `endpoint` no client ou `AWS_ENDPOINT_URL_SQS` / `AWS_ENDPOINT_URL`. Veja [Service-specific endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html) e [Region](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html).
- **QueueUrl.** O client v3 (`useQueueUrlAsEndpoint`, padrão `true`) só usa a origem da `QueueUrl` como endpoint quando **não** há `endpoint` customizado configurado. Isso está no [código do middleware](https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/middleware-sdk-sqs/src/queue-url.ts). Com `endpoint` setado, vale o endpoint. Mesmo assim, prefira obter a URL com `GetQueueUrl` **no boot** e não hardcode `http://localhost:4566/...` (veja §6).
- **Retries do SDK.**
  - Modo `standard` (padrão): `maxAttempts=3`, backoff exponencial com jitter e um token bucket de retry. `ReceiveMessage` recebe tratamento especial de long polling. Veja [Retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
  - Esses retries são **de transporte**. O retry de **negócio** é o backoff com visibilidade (§3), que é outra camada.
  - Um retry automático de `SendMessage` em FIFO é seguro porque usa o mesmo dedup id.
- **`SendMessageBatch`** (para o outbox):
  - Até 10 entries. O `Id` tem até 80 caracteres, só `[A-Za-z0-9_-]`, e deve ser único no batch. Cada entry leva o seu próprio `MessageGroupId` / `MessageDeduplicationId`.
  - A resposta vem em `Successful[]` e `Failed[]`: **falha parcial não lança exceção**. Marque `published_at` só para as entries de `Successful` e reagende as de `Failed`.
  - Fonte: [SendMessageBatch](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessageBatch.html).
- Exemplos oficiais: [SQS code examples (JS v3)](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html). Referência da API: [client-sqs](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/).

---

## 5. `sqs-consumer` (BBC) vs. loop próprio

[`bbc/sqs-consumer`](https://github.com/bbc/sqs-consumer) (v15.0.4, set/2026):
- Oferece `handleMessage` / `handleMessageBatch`, `batchSize`, `visibilityTimeout` + `heartbeatInterval`, `terminateVisibilityTimeout` e `stop({ abort })` + `pollingCompleteWaitTimeMs`.
- **FIFO não é testado oficialmente.** O README emite um warning (`suppressFifoWarning`) e diz para usar `handleMessageBatch` para manter a ordem.
- `stop()` emite `stopped` **imediatamente**, mesmo com handler rodando. Para esperar as mensagens in-flight é preciso `pollingCompleteWaitTimeMs`. Com `abort: true`, o heartbeat e os deletes pendentes são cancelados.
- O modelo é "retornou = ack, lançou = não ack". Ele não tem ganchos nativos para backoff por `ApproximateReceiveCount`, para envio explícito à DLQ nem para "mensagem posterior do mesmo grupo não pode ser processada antes".

**Recomendação: loop próprio, de ~150 linhas, como provider NestJS.** O desafio avalia exatamente essa semântica: ack após commit, classificação negócio/transitório/permanente, backoff via visibilidade, DLQ explícita, devolução no SIGTERM e ordem por grupo dentro do batch. Uma lib que não testa FIFO e esconde o ciclo de ack é mais risco do que economia. Em Bun, o `AbortController` e o `NodeHttpHandler` funcionam.

---

## 6. MiniStack

**Básico** (fontes: [README](https://github.com/ministackorg/ministack) e [site](https://ministack.org)):
- Imagem `ministackorg/ministack` (MIT). A variante `:full` traz extras que este projeto não usa. **Fixe uma tag** (ex.: `1.5.24`), porque o projeto lança releases quase diárias.
- Porta **4566**, configurável com `GATEWAY_PORT`.
- Health: `GET /_ministack/health`, também em `/_localstack/health` e `/health`. Ele retorna 200 assim que o HTTP sobe.
- Readiness: **`GET /_ministack/ready`** retorna **503 até que os scripts de `ready.d` terminem**. Use esse endpoint no healthcheck.
- Variáveis úteis:

  | Variável | Padrão | O que faz |
  |---|---|---|
  | `MINISTACK_REGION` | `us-east-1` | Região |
  | `MINISTACK_ACCOUNT_ID` | `000000000000` | Conta |
  | `LOG_LEVEL` | `INFO` | Nível de log |
  | `PERSIST_STATE` | `0` | `1` persiste o estado |
  | `STATE_DIR` | `/tmp/ministack-state` | Onde o estado é gravado |
  | `MINISTACK_HOST` | — | Host fixo nas `QueueUrl` |

  A imagem não traz `curl` nem `wget`. O healthcheck usa `python` (o mesmo padrão do Dockerfile oficial).
- **Init scripts** (`*.sh` / `*.py`, executados em ordem alfabética):
  - **Diretórios:** `ready.d` fica em `/docker-entrypoint-initaws.d/ready.d/` ou no path compatível com LocalStack, **`/etc/localstack/init/ready.d/`**. `boot.d` roda antes do HTTP subir.
  - **O que o script recebe:** `AWS_ENDPOINT_URL` e credenciais injetados. O `aws` CLI e o `awslocal` já vêm na imagem.
  - **Reset:** `POST /_ministack/reset?init=1` reseta o estado e roda os init scripts de novo.
- Também é possível criar as filas pelo SDK (`CreateQueue`, que é idempotente com atributos iguais) no setup dos testes de integração.
- Inspeção: `GET /_ministack/sqs/messages?QueueUrl=...` mostra `ReceiveCount`, `VisibleAt` e `IsVisible`. Útil em asserts de teste.

**Exemplo de `ready.d/01-sqs.sh`:**
```bash
#!/bin/bash
set -euo pipefail
ACC=000000000000; R=us-east-1
aws sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600
aws sqs create-queue --queue-name wager-transactions.fifo --attributes '{
  "FifoQueue":"true","VisibilityTimeout":"60","ReceiveMessageWaitTimeSeconds":"20",
  "RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:'$R':'$ACC':wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"5\"}"}'
aws sqs create-queue --queue-name wallet-events.fifo --attributes FifoQueue=true
```

**O que funciona** (conferido no código de `sqs.py`):
- FIFO com sufixo `.fifo` obrigatório e `MessageGroupId` obrigatório. `DelaySeconds` por mensagem é rejeitado em FIFO.
- Dedup com janela real de **5 min a partir do envio**. A janela não é limpa no delete (bug [#1326](https://github.com/ministackorg/ministack/issues/1326), corrigido). `ContentBasedDeduplication` usa SHA-256 do body, e `DeduplicationScope=messageGroup` é respeitado.
- **Uma mensagem in-flight bloqueia o grupo.** Vários itens do mesmo grupo podem vir no mesmo receive, como na AWS.
- `RedrivePolicy` é validada (JSON, `maxReceiveCount` de 1 a 1000, ARN existente na mesma conta e região). A mensagem vai para a DLQ quando `receive_count >= maxReceiveCount` e ela está visível, avaliado no próximo receive. Ela chega com `DeadLetterQueueSourceArn`, e numa DLQ FIFO o enqueue timestamp reseta.
- `ApproximateReceiveCount`, `ApproximateFirstReceiveTimestamp`, `SequenceNumber`, `MessageGroupId` e `MessageDeduplicationId` são aceitos tanto em `AttributeNames` quanto em `MessageSystemAttributeNames`.
- Long polling até 20 s, com polling interno a cada 100 ms. `WaitTimeSeconds=0` / `VisibilityTimeout=0` explícitos são respeitados (bug [#1295](https://github.com/ministackorg/ministack/issues/1295), corrigido). `ChangeMessageVisibility` com 0 funciona.
- Batch com validação de até 10 entries e formato do `Id`. Protocolos JSON e Query.
- A `QueueUrl` reflete o header `Host` da requisição quando `MINISTACK_HOST` **não** está definido. Assim, um app que chama `GetQueueUrl` em `http://ministack:4566` recebe uma URL com o host `ministack`.

> ### ⚠️ RISCOS / LIMITAÇÕES DO MINISTACK
> 1. **Não valida o tipo da DLQ** (código: `_validate_redrive_policy`). Uma DLQ **standard** para uma origem FIFO é aceita, mas a AWS rejeita. **Um erro no init script passa localmente.** Garanta os dois `.fifo` por convenção e com um teste.
> 2. **`RedriveAllowPolicy` não é aplicada**: o atributo é armazenado, mas não restringe nada. `StartMessageMoveTask` (redrive da DLQ) **não está** na lista de operações suportadas.
> 3. **`ReceiveRequestAttemptId` é ignorado**: retry do receive não devolve o mesmo lote.
> 4. **`ChangeMessageVisibility` sem validação**: não verifica a faixa de 0 a 43200, não aplica o teto de 12 h e não retorna `MessageNotInflight`. Um bug de backoff (ex.: valor negativo ou > 12 h) não falha localmente.
> 5. **Sem quotas nem throttling**: não há limite de 300 TPS, de 120k in-flight nem `RequestThrottled`. Testes de carga contra o emulador **não** validam throughput.
> 6. **Ordenação "perfeita demais"**: é um processo único, em memória, sem partições nem amostragem de short polling. Bugs que dependem de redelivery ou de atraso real podem não aparecer. Force redelivery nos testes (visibilidade curta, kill do consumer).
> 7. **Estado em memória**: um restart do container apaga filas e mensagens, a menos que `PERSIST_STATE=1`. Os testes devem recriar as filas (init script ou `CreateQueue` no setup).
> 8. **Credenciais não são verificadas**, mesmo com `AUTH=true` (issue [#1745](https://github.com/ministackorg/ministack/issues/1745), aberta). Erros de IAM ou de assinatura não aparecem.
> 9. **`/_ministack/ready` fica "completed" mesmo se um script falhar.** Use `set -e` e, de preferência, um healthcheck que confira a fila (ex.: `GetQueueUrl`) ou um teste de setup que falhe cedo.
> 10. **Projeto jovem e com mudanças rápidas**: vários bugs de SQS foram corrigidos em ago–out/2026 (#1295, #1296, #1326, #2012, #2048). Fixe a versão e rode a suíte de integração ao atualizar.
> 11. Com `MINISTACK_HOST` definido, toda `QueueUrl` usa esse host fixo. Se ele for `localhost`, um app em outro container passa a chamar a si mesmo. **Não defina `MINISTACK_HOST`** ou use o nome do serviço.

**LocalStack como fallback** ([SQS](https://docs.localstack.cloud/aws/services/sqs/), [init hooks](https://docs.localstack.cloud/aws/capabilities/config/initialization-hooks/)):
- Imagem `localstack/localstack`, porta **4566**, health em `/_localstack/health`. Scripts em `/etc/localstack/init/ready.d/`, o mesmo path que o MiniStack aceita, então **o mesmo init script serve para os dois**.
- **⚠️ Desde a 2026.03.0, o LocalStack exige `LOCALSTACK_AUTH_TOKEN`** para subir. Há um plano gratuito, mas só para uso não comercial. Fontes: [anúncio](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/), [single image](https://blog.localstack.cloud/localstack-single-image-next-steps/). Isso é atrito para o avaliador rodar o projeto. Tags antigas fixadas ainda funcionam sem token.
- A emulação de SQS é madura e o LocalStack é a referência histórica. Use-o se algum dos riscos 1–4 acima se tornar relevante para os testes.

---

## 7. docker-compose (MiniStack com healthcheck)

```yaml
services:
  ministack:
    image: ministackorg/ministack:1.5.24   # fixar versão
    ports: ["4566:4566"]
    environment:
      MINISTACK_REGION: us-east-1
      LOG_LEVEL: INFO
      # NÃO definir MINISTACK_HOST (QueueUrl reflete o Host usado pelo cliente)
    volumes:
      - ./infra/ministack/ready.d:/etc/localstack/init/ready.d:ro   # compatível com LocalStack
    healthcheck:
      # 200 só depois que os scripts de ready.d terminam (imagem sem curl/wget)
      test: ["CMD", "python", "-c", "import urllib.request as r; r.urlopen('http://localhost:4566/_ministack/ready')"]
      interval: 3s
      timeout: 3s
      retries: 20
      start_period: 5s

  app:
    environment:
      AWS_REGION: us-east-1
      SQS_ENDPOINT: http://ministack:4566
      AWS_ACCESS_KEY_ID: test        # fake, só local
      AWS_SECRET_ACCESS_KEY: test
    depends_on:
      ministack: { condition: service_healthy }
    stop_grace_period: 30s           # > deadline de drenagem do consumer no SIGTERM
```

`urlopen` lança exceção em uma resposta 503, então o comando sai com código ≠ 0 e o container fica "unhealthy" até os scripts terminarem.
