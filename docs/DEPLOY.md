# Ambiente de demonstração (opcional)

Ambiente de demonstração pronto para subir, localmente ou num servidor com Docker (ex.: um droplet da DigitalOcean), para acessar a solução pelo navegador sem instalar nada. **Não há um ambiente publicado**: o caminho principal de avaliação é o local (`README.md`). A demonstração é uma conveniência, com prazo de expiração configurável (`DEMO_EXPIRES`).

## O que é igual e o que muda em relação ao local

| | Ambiente local (`docker-compose.yml`) | Demonstração (`docker-compose.demo.yml`) |
|---|---|---|
| Aplicação | mesma imagem (`Dockerfile`) | **mesma imagem**, nenhuma linha de código diferente |
| Autenticação da API | nenhuma (§2, decisão documentada) | **nenhuma**, igual à entrega. Nada é acrescentado na frente da API |
| Health checks | abertos | abertos (§2) |
| Instâncias | 1 (ou `--scale app=3`) | 3 réplicas |
| PostgreSQL / MiniStack | portas publicadas no host para desenvolvimento | **sem porta pública** (só a rede interna do Compose) |
| Senhas do banco | fixas, só desenvolvimento | aleatórias, geradas no deploy (`infra/demo/.env.demo`, fora do repositório) |
| Ferramentas | pgweb e sqs-admin (perfil `tools`) | pgweb **somente leitura** e página de filas **somente leitura** |
| Operação | — | restart automático, rotação de logs, `NODE_ENV=production`, estado do MiniStack persistido |

Num servidor, o ambiente fica **aberto publicamente**, sem lista de IPs e sem credenciais. As ferramentas de inspeção existem para quem acessa ver tudo, mas são somente leitura em mais de uma camada:

- **pgweb** (banco):
  - modo `--readonly`, que recusa `INSERT`, `UPDATE`, `DELETE` e DDL;
  - conexão travada (`--lock-session`), sem como trocar de usuário ou banco;
  - role `wagering_readonly`, só com `SELECT` (até uma transação de escrita forçada recebe `permission denied`);
  - transações read-only, `statement_timeout` de 5 s e no máximo 5 conexões.
- **Página de filas:**
  - usa a inspeção do MiniStack, que **não consome** mensagens nem altera a visibilidade;
  - o gateway expõe só essa rota, só por `GET` e só para as 3 filas do sistema;
  - criar, apagar, esvaziar ou enviar mensagens não é possível.

## Portas

| Porta | Conteúdo |
|---|---|
| 80 | Página da demo, API, Swagger (`/docs`), página de estrutura (`/arquitetura`), health (`/health/live`, `/health/ready`) e métricas (`/metrics`) |
| 8081 | pgweb: todas as tabelas, consultas `SELECT` |
| 8082 | Filas: entrada, DLQ e eventos publicados, com o conteúdo das mensagens |

Todas as respostas trazem o header `X-Demo-Environment: temporary; expires=<DEMO_EXPIRES>`.

## 1. Criar o servidor (exemplo: droplet da DigitalOcean)

1. Na DigitalOcean: **Create → Droplets → Marketplace → "Docker on Ubuntu"**.
2. Tamanho: **Basic, 2 vCPU / 4 GB** (suficiente para a demonstração; para rodar o teste de carga, 4 vCPU / 8 GB).
3. Região: a mais próxima de quem vai acessar.
4. Autenticação: **SSH key** (a sua chave pública).
5. Crie e anote o **IP público**.

## 2. Firewall (DigitalOcean Cloud Firewall)

**Networking → Firewalls → Create Firewall**, aplicado ao droplet:

| Inbound | Porta | Origem |
|---|---|---|
| SSH | 22 | All IPv4, All IPv6 (acesso só por chave) |
| HTTP | 80 | All IPv4, All IPv6 |
| Custom TCP | 8081 | All IPv4, All IPv6 |
| Custom TCP | 8082 | All IPv4, All IPv6 |

Outbound: tudo liberado (padrão). PostgreSQL e MiniStack não publicam portas, então não aparecem aqui.

## 3. Subir

Na sua máquina, na raiz do projeto (precisa de `ssh`, `rsync` e `openssl`):

```bash
scripts/deploy-demo.sh <IP-DO-DROPLET>
```

O script:
1. Gera as senhas do banco em `infra/demo/.env.demo` (só na primeira vez).
2. Confere se o droplet tem Docker Compose e CPU com AVX, necessário para o Bun 1.4.2.
3. Copia o projeto via `rsync`, sem `node_modules`, `.git` nem arquivos locais.
4. Faz o build e sobe tudo (`up --build --wait`).
5. Gera os dados de demonstração (`scripts/demo.ts`: alice, bob e carol, via HTTP e SQS).
6. Imprime os links.

Para atualizar depois, rode o mesmo comando (é idempotente). `RESEED=1` regera os dados de demonstração.

### Rodar localmente (sem servidor)

```bash
scripts/deploy-demo.sh --local   # mesmos passos; portas 48080 / 48081 / 48082; projeto separado do ambiente de dev
```

Links: http://localhost:48080 (página, API, `/docs`, `/arquitetura`), http://localhost:48081 (pgweb) e http://localhost:48082 (filas). Para parar: `COMPOSE_PROJECT_NAME=wagering-demo docker compose -f docker-compose.demo.yml --env-file infra/demo/.env.demo stop`.

## 4. Conferir

- `http://<IP>/`: página da demo, com as wallets geradas.
- `http://<IP>/health/ready`: `{"status":"ok","checks":{"database":"up","sqs":"up"}}`.
- `http://<IP>/docs`: Swagger, com "Try it out".
- `http://<IP>/arquitetura`: página de estrutura (camadas, domínio, dados, fluxos e falhas, em diagramas).
- `http://<IP>:8081`: pgweb. Na aba Query, a consulta do invariante (está na página da demo) não deve retornar linhas.
- `http://<IP>:8082`: filas. A de entrada fica vazia; a DLQ tem 1 mensagem (a malformada do demo); os eventos publicados ficam visíveis.

Logs, se precisar: `ssh root@<IP> 'cd /opt/wagering-demo && docker compose -f docker-compose.demo.yml --env-file infra/demo/.env.demo logs --tail 100 app'`.

## 5. Destruir (no fim do prazo)

1. DigitalOcean: **Destroy** no droplet e remover o Cloud Firewall.
2. Localmente: `rm infra/demo/.env.demo`. As senhas perdem o sentido junto com o servidor.

## Verificado localmente (`scripts/deploy-demo.sh --local`)

- Página, API, health, Swagger e métricas na porta 80, sem credenciais, com o header de expiração.
- Só o gateway publica portas; PostgreSQL e MiniStack ficam inacessíveis de fora.
- pgweb: `SELECT` funciona; `INSERT`, `UPDATE` e `DELETE` são recusados; `pg_sleep(10)` é cortado em 5 s; trocar a conexão retorna "Session is locked"; direto no banco, a role `wagering_readonly` recebe `permission denied` mesmo forçando uma transação de escrita.
- Filas: as 3 filas são lidas. `POST`, outras filas, outro host e outras rotas do MiniStack são recusados. Depois de 10 leituras, a mensagem da DLQ continua com `ReceiveCount` 0. Com a fila de entrada sendo lida a cada 100 ms, 5 mensagens enviadas foram processadas normalmente e a reconciliação seguiu consistente.
