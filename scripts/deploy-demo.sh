#!/usr/bin/env bash
# Sobe o ambiente TEMPORÁRIO de demonstração (docker-compose.demo.yml).
#
#   scripts/deploy-demo.sh <ip-do-droplet> [usuario-ssh]   # deploy no droplet (padrão: root)
#   scripts/deploy-demo.sh --local                          # mesmos passos nesta máquina (portas 48080-48082)
#
# Variáveis opcionais: DEMO_EXPIRES (AAAA-MM-DD, padrão: daqui a 14 dias), RESEED=1 (regera os dados de demo).
# Gera senhas aleatórias do banco em infra/demo/.env.demo na primeira execução (fora do repositório).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "uso: scripts/deploy-demo.sh <ip-do-droplet> [usuario-ssh] | --local" >&2
  exit 2
fi
SSH_USER="${2:-root}"
REMOTE_DIR=/opt/wagering-demo
ENV_FILE=infra/demo/.env.demo
COMPOSE="docker compose -f docker-compose.demo.yml --env-file $ENV_FILE"

# 1. Segredos do ambiente (uma vez). Hex: sem caracteres que precisem de escape em URL/SQL.
if [[ ! -f "$ENV_FILE" ]]; then
  {
    echo "DEMO_DB_OWNER_PASSWORD=$(openssl rand -hex 24)"
    echo "DEMO_APP_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "DEMO_READONLY_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "DEMO_EXPIRES=${DEMO_EXPIRES:-$(date -u -v+14d +%F 2>/dev/null || date -u -d '+14 days' +%F)}"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "• segredos gerados em $ENV_FILE"
fi
if [[ -n "${DEMO_EXPIRES:-}" ]]; then
  sed -i.bak "s/^DEMO_EXPIRES=.*/DEMO_EXPIRES=${DEMO_EXPIRES}/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
fi

# Gera os dados de demonstração dentro da rede do compose (API pelo gateway, SQS pelo MiniStack).
SEED_CMD="$COMPOSE run --rm --no-deps --user root \
  -v \$PWD/scripts:/app/scripts:ro -v \$PWD/infra/demo/site:/out \
  -e DEMO_API_URL=http://gateway -e SQS_ENDPOINT=http://ministack:4566 \
  -e DEMO_OUTPUT_FILE=/out/demo.json -e DEMO_EXPIRES=\$(grep ^DEMO_EXPIRES= $ENV_FILE | cut -d= -f2) \
  --entrypoint bun app scripts/demo.ts"
UP_AND_SEED="$COMPOSE up -d --build --wait && { [[ -f infra/demo/site/demo.json && \"${RESEED:-0}\" != 1 ]] || $SEED_CMD; }"

if [[ "$TARGET" == "--local" ]]; then
  # Teste local: projeto e volumes separados do ambiente de desenvolvimento; portas altas.
  export COMPOSE_PROJECT_NAME=wagering-demo DEMO_HTTP_PORT=48080 DEMO_DB_PORT=48081 DEMO_QUEUES_PORT=48082
  bash -c "$UP_AND_SEED"
  HOST=localhost; HTTP_PORT=48080; DB_PORT=48081; QUEUES_PORT=48082
else
  HOST="$TARGET"; HTTP_PORT=80; DB_PORT=8081; QUEUES_PORT=8082
  REMOTE="$SSH_USER@$HOST"

  # 2. Pré-checagens no droplet: Docker Compose e CPU com AVX (o Bun 1.4.2 trava sem AVX).
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" 'docker compose version >/dev/null && grep -qm1 avx /proc/cpuinfo' \
    || { echo "o droplet precisa de Docker Compose e CPU com AVX" >&2; exit 1; }

  # 3. Copia o projeto (sem dependências, histórico, cobertura nem resultados locais).
  ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
  rsync -az --delete \
    --exclude node_modules --exclude .git --exclude coverage --exclude docs/load-test \
    --exclude .env --exclude .env.test --exclude .DS_Store --exclude infra/demo/site/demo.json \
    ./ "$REMOTE:$REMOTE_DIR/"

  # 4. Build, subida (espera tudo ficar saudável) e dados de demonstração.
  ssh "$REMOTE" "cd $REMOTE_DIR && $UP_AND_SEED"
fi

cat <<EOF

Ambiente de demonstração no ar (expira em $(grep ^DEMO_EXPIRES= "$ENV_FILE" | cut -d= -f2)):
  Página da demo   http://$HOST:$HTTP_PORT/
  API (Swagger)    http://$HOST:$HTTP_PORT/docs
  Readiness        http://$HOST:$HTTP_PORT/health/ready
  Banco (pgweb)    http://$HOST:$DB_PORT/      somente leitura
  Filas            http://$HOST:$QUEUES_PORT/      somente leitura

EOF
