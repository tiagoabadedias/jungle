import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import { UniqueViolationError, WalletAlreadyExistsError } from '../../shared/application/application-error.ts';
import { moneyFromInput } from '../../shared/application/money-input.ts';
import { eventContext, type RequestContext } from '../../shared/application/event-context-factory.ts';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import type { MoneyProps } from '../../shared/domain/money.ts';
import type { Clock } from '../../shared/application/ports/clock.ts';
import type { IdGenerator } from '../../shared/application/ports/id-generator.ts';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-events.ts';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.ts';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.ts';
import { Wallet } from '../domain/wallet.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  context: RequestContext;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Saldo inicial > 0 gera a transação interna OPENING e o CREDIT no ledger
 * na mesma transação SQL, junto com os eventos na outbox (§9, §11).
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = moneyFromInput(command.initialBalance);
    try {
      return await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        const at = this.clock.now();
        const walletId = this.ids.next();
        const opening = initialBalance.isPositive()
          ? WagerTransaction.opening({ id: this.ids.next(), walletId, playerId: command.playerId, money: initialBalance, at })
          : undefined;
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: opening?.id,
          openingEntryId: opening === undefined ? undefined : this.ids.next(),
          at,
        });

        await wallets.insert(wallet);
        if (opening !== undefined && openingEntry !== undefined) {
          await transactions.insert(opening);
          await ledger.insert(openingEntry);
          await outbox.insert([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext(this.ids, at, command.context))),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext(this.ids, at, command.context))),
          ]);
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.duplicate === 'WALLET') {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

