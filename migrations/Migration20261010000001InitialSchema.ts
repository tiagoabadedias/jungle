import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade do §6 vivem
 * aqui, no banco (§5.9), e não só no código. Dinheiro em `bigint` (unidades menores).
 *
 * Escrita à mão: o diff automático do MikroORM não conhece triggers, índices parciais nem
 * CHECKs compostos e tentaria removê-los. `down()` desfaz tudo na ordem inversa.
 */
export class Migration20261010000001InitialSchema extends Migration {
  override up(): void {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id             uuid           primary key,
        player_id      uuid           not null,
        currency       char(3)        not null,
        balance_minor  bigint         not null,
        version        integer        not null,
        created_at     timestamptz(6) not null,
        updated_at     timestamptz(6) not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance_minor >= 0),
        constraint wallets_version_positive_ck check (version >= 1)
      );
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        text           not null,
        external_transaction_id            text           not null,
        idempotency_key                    text           not null,
        payload_hash                       char(64)       not null,
        wallet_id                          uuid           not null,
        player_id                          uuid           not null,
        round_id                           text           not null,
        game_id                            text           not null,
        kind                               text           not null,
        status                             text           not null,
        amount_minor                       bigint         not null,
        currency                           char(3)        not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid,
        failure_code                       text,
        observed_balance_minor             bigint,
        observed_balance_currency          char(3),
        reference_attempts                 integer        not null default 0,
        next_reference_attempt_at          timestamptz(6),
        processed_at                       timestamptz(6),
        created_at                         timestamptz(6) not null,
        updated_at                         timestamptz(6) not null,

        constraint wager_transactions_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_reference_fk foreign key (reference_transaction_id) references wager_transactions (id),

        -- Idempotência persistente (§5.2, §9) e resolução de referência por (provider, id externo) (§7.2)
        constraint wager_transactions_id_wallet_uq unique (id, wallet_id),
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),

        constraint wager_transactions_text_fields_ck check (
          length(btrim(provider_id)) between 1 and 128
          and length(btrim(external_transaction_id)) between 1 and 256
          and length(btrim(idempotency_key)) between 1 and 512
          and length(btrim(round_id)) between 1 and 256
          and length(btrim(game_id)) between 1 and 256
        ),
        constraint wager_transactions_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_kind_ck check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        -- PENDING só existe em memória dentro da transação SQL; nunca é persistido.
        constraint wager_transactions_status_ck check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_ck check (amount_minor > 0 or (kind = 'LOSS' and amount_minor = 0)),

        -- Referência: obrigatória em REFUND/ROLLBACK, opcional em WIN, proibida no resto (§7.1, PLAN §10)
        constraint wager_transactions_reference_required_ck check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_transactions_reference_allowed_ck check (
          kind in ('WIN', 'REFUND', 'ROLLBACK') or reference_external_transaction_id is null
        ),
        constraint wager_transactions_reference_not_blank_ck check (
          reference_external_transaction_id is null or length(btrim(reference_external_transaction_id)) > 0
        ),
        constraint wager_transactions_reference_not_self_ck check (reference_transaction_id is null or reference_transaction_id <> id),
        constraint wager_transactions_processed_reference_resolved_ck check (
          status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null
        ),

        -- Coerência de estado
        constraint wager_transactions_failure_code_ck check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)
        ),
        constraint wager_transactions_failure_code_values_ck check (failure_code is null or failure_code in (
          'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH',
          'REFERENCE_NOT_FOUND', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND',
          'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REVERSED', 'INFRA_PERMANENT_FAILURE'
        )),
        constraint wager_transactions_processed_at_ck check (status = 'PENDING_REFERENCE' or processed_at is not null),
        constraint wager_transactions_pending_schedule_ck check (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)
        ),
        constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),

        -- Saldo observado na decisão (replay, §7.7): moeda própria, pois é a moeda da wallet
        constraint wager_transactions_observed_balance_pair_ck check (
          (observed_balance_minor is null) = (observed_balance_currency is null)
        ),
        constraint wager_transactions_observed_balance_ck check (observed_balance_minor is null or observed_balance_minor >= 0),
        constraint wager_transactions_observed_balance_required_ck check (status = 'FAILED' or observed_balance_minor is not null)
      );
    `);

    // Uma referência é revertida no máximo uma vez, por qualquer kind (§7.4, PLAN §10.1).
    // WIN também preenche reference_transaction_id, por isso o filtro por kind.
    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_created_idx on wager_transactions (wallet_id, created_at, id);`);
    this.addSql(`create index wager_transactions_reference_idx on wager_transactions (reference_transaction_id) where reference_transaction_id is not null;`);

    // Estados terminais são imutáveis; campos de negócio nunca mudam; nada é apagado (§6.3).
    this.addSql(`
      create function wager_transactions_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted (transaction %)', old.id
            using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot be modified', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount_minor, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount_minor, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'business fields of wager transaction % are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_trg
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id                    uuid           primary key,
        wallet_id             uuid           not null,
        transaction_id        uuid           not null,
        direction             text           not null,
        amount_minor          bigint         not null,
        currency              char(3)        not null,
        balance_before_minor  bigint         not null,
        balance_after_minor   bigint         not null,
        created_at            timestamptz(6) not null,
        -- FK composta: o lançamento está na moeda da wallet
        constraint wallet_ledger_entries_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency),
        -- FK composta: o lançamento pertence à mesma wallet da transação que o gerou
        constraint wallet_ledger_entries_transaction_fk foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        -- No máximo um lançamento por transação por wallet (§6.4)
        constraint wallet_ledger_entries_transaction_wallet_uq unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount_minor > 0),
        constraint wallet_ledger_entries_balances_non_negative_ck check (balance_before_minor >= 0 and balance_after_minor >= 0),
        -- balanceBefore ± money === balanceAfter (§6.4)
        constraint wallet_ledger_entries_balanced_ck check (
          (direction = 'CREDIT' and balance_after_minor = balance_before_minor + amount_minor)
          or (direction = 'DEBIT' and balance_after_minor = balance_before_minor - amount_minor)
        )
      );
    `);
    this.addSql(`create index wallet_ledger_entries_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at, id);`);

    // Ledger append-only (§5.5): UPDATE/DELETE por linha e TRUNCATE por statement.
    // TRUNCATE não dispara triggers de DELETE, por isso o trigger próprio.
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete_trg
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate_trg
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only();
    `);

    // ------------------------------------------------------------------ inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  text           not null,
        message_id     text           not null,
        payload_hash   char(64)       not null,
        received_at    timestamptz(6) not null,
        processed_at   timestamptz(6),
        -- Deduplicação persistente por (consumerName, messageId) (§10)
        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint inbox_messages_ids_ck check (length(btrim(consumer_name)) > 0 and length(btrim(message_id)) > 0)
      );
    `);

    // ----------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        id               uuid           primary key,
        aggregate_id     uuid           not null,
        event_type       text           not null,
        payload          jsonb          not null,
        occurred_at      timestamptz(6) not null,
        attempts         integer        not null default 0,
        next_attempt_at  timestamptz(6),
        published_at     timestamptz(6),
        constraint outbox_messages_attempts_ck check (attempts >= 0),
        constraint outbox_messages_event_type_ck check (event_type in (
          'WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged', 'WagerTransactionPendingReference'
        )),
        constraint outbox_messages_payload_object_ck check (jsonb_typeof(payload) = 'object'),
        constraint outbox_messages_schedule_ck check (published_at is null or next_attempt_at is null)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;
    `);

    // -------------------------------------------------------------- privilégios
    // A aplicação usa wagering_app: sem posse das tabelas, sem DELETE e sem UPDATE no ledger.
    // A role (com login) é criada pelo initdb do compose; num Postgres sem esse script, a
    // migration cria a role sem login para que os grants não falhem.
    this.addSql(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'wagering_app') then
          create role wagering_app nologin;
        end if;
      end $$;
    `);
    this.addSql(`revoke all on wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages from public;`);
    this.addSql(`grant select, insert, update on wallets, wager_transactions, inbox_messages, outbox_messages to wagering_app;`);
    this.addSql(`grant select, insert on wallet_ledger_entries to wagering_app;`);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists wallet_ledger_entries_append_only();`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop function if exists wager_transactions_guard();`);
    this.addSql(`drop table if exists wallets;`);
  }
}
