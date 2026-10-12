import { InboxMessageSchema } from '../../../messaging/infrastructure/persistence/inbox-persistence.ts';
import { OutboxMessageSchema } from '../../../messaging/infrastructure/persistence/outbox-persistence.ts';
import { WagerTransactionSchema } from '../../../wagering/infrastructure/persistence/wager-transaction-persistence.ts';
import { LedgerEntrySchema, WalletSchema } from '../../../wallet/infrastructure/persistence/wallet-persistence.ts';

/** Todas as EntitySchemas, registradas explicitamente (sem descoberta por glob). */
export const ENTITY_SCHEMAS = [WalletSchema, LedgerEntrySchema, WagerTransactionSchema, OutboxMessageSchema, InboxMessageSchema];
