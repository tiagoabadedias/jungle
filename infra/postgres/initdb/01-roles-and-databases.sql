-- Executado uma única vez, na criação do volume do PostgreSQL.
--
-- Duas identidades:
--   * wagering      (POSTGRES_USER) — dona das tabelas; usada só para rodar migrations.
--   * wagering_app  — usada pela aplicação. NÃO é dona das tabelas: não consegue desligar
--                     triggers (ALTER TABLE ... DISABLE TRIGGER exige ser dono), não tem
--                     DELETE em nenhuma tabela nem UPDATE no ledger (§5.5, §5.9).
-- Credenciais apenas para o ambiente local de desenvolvimento.
CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app';

-- Banco isolado para os testes de integração e concorrência.
CREATE DATABASE wagering_test OWNER wagering;
