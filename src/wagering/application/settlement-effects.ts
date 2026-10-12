import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import type { TransactionScope } from '../../shared/application/ports/unit-of-work.ts';
import type { EventContext, IntegrationEvent } from '../../shared/domain/integration-event.ts';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events.ts';
import type { SettlementResult } from '../domain/wager-settlement.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.ts';

export interface SettlementEffectsInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Versão da wallet antes da liquidação: a gravação do saldo confere que ninguém a mudou. */
  versionBefore: number;
  result: SettlementResult;
  /** Novo contexto (eventId próprio) para cada evento, na ordem em que são criados. */
  nextEventContext: () => EventContext;
  /**
   * Emite `WagerTransactionPendingReference`? Sim na primeira vez que a referência falta;
   * não no reagendamento pelo worker (o evento de pendência já foi emitido).
   */
  announcePendingReference: boolean;
}

/**
 * Efeitos de uma liquidação, iguais para a entrada (HTTP/SQS) e para o worker de referências:
 * lançamento no ledger, saldo e eventos na outbox, tudo na transação SQL do chamador (§6.5, §11).
 * A transação já deve ter sido gravada (o lançamento a referencia).
 */
export async function recordSettlementEffects(scope: TransactionScope, input: SettlementEffectsInput): Promise<void> {
  const { transaction, wallet, result } = input;
  const events: IntegrationEvent<unknown>[] = [];
  switch (result.outcome) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, input.nextEventContext()));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, input.nextEventContext()));
      break;
    case WagerTransactionStatus.PendingReference:
      if (input.announcePendingReference) {
        events.push(WagerTransactionPendingReference.from(transaction, input.nextEventContext()));
      }
      break;
  }
  if (result.outcome === WagerTransactionStatus.Processed && result.ledgerEntry !== undefined) {
    await scope.ledger.insert(result.ledgerEntry);
    await scope.wallets.saveBalance(wallet, input.versionBefore);
    events.push(WalletBalanceChanged.from(wallet, result.ledgerEntry, input.nextEventContext()));
  }
  await scope.outbox.insert(events.map((event) => OutboxMessage.enqueue(event)));
}
