#!/bin/bash
# Roles do ambiente de demonstração. Senhas vêm do .env.demo gerado no deploy (nada fixo no repositório).
#   wagering           dona das tabelas (POSTGRES_USER) — só migrations
#   wagering_app       aplicação (mesmos privilégios do ambiente local, concedidos pela migration)
#   wagering_readonly  pgweb: só SELECT, transações read-only, timeout de 5 s, no máximo 5 conexões
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE wagering_app LOGIN PASSWORD '${DEMO_APP_DB_PASSWORD}';
CREATE ROLE wagering_readonly LOGIN PASSWORD '${DEMO_READONLY_DB_PASSWORD}' CONNECTION LIMIT 5;
ALTER ROLE wagering_readonly SET default_transaction_read_only = on;
ALTER ROLE wagering_readonly SET statement_timeout = '5s';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO wagering_readonly;
GRANT USAGE ON SCHEMA public TO wagering_readonly;
-- Tabelas criadas depois pelas migrations (dona: wagering) já nascem legíveis pela role de leitura.
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public GRANT SELECT ON TABLES TO wagering_readonly;
EOSQL
