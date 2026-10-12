import type { InboxRepository } from '../../../messaging/application/ports/inbox.repository.ts';
import type { OutboxRepository } from '../../../messaging/application/ports/outbox.repository.ts';
import type { WagerTransactionRepository } from '../../../wagering/application/ports/wager-transaction.repository.ts';
import type { LedgerRepository } from '../../../wallet/application/ports/ledger.repository.ts';
import type { WalletRepository } from '../../../wallet/application/ports/wallet.repository.ts';

/** Repositórios ligados a uma mesma transação SQL: tudo é confirmado junto ou nada é (§6.5, §11). */
export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL. Commit se resolver; rollback se lançar.
   * Falhas transitórias (lock não obtido, banco indisponível) viram TransientInfrastructureError.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
