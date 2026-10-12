import { InboxMessage } from '../../messaging/domain/inbox-message.ts';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  MessageConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../../shared/application/application-error.ts';
import { moneyFromInput } from '../../shared/application/money-input.ts';
import { eventContext, type RequestContext } from '../../shared/application/event-context-factory.ts';
import type { TransactionScope, UnitOfWork } from '../../shared/application/ports/unit-of-work.ts';
import { DomainError } from '../../shared/domain/domain-error.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { Clock } from '../../shared/application/ports/clock.ts';
import type { IdGenerator } from '../../shared/application/ports/id-generator.ts';
import { computePayloadHash, type WagerPayloadFields } from '../domain/payload-hash.ts';
import { settleWagerTransaction } from '../domain/wager-settlement.ts';
import { INTERNAL_PROVIDER_ID, type ReferenceRetryPolicy, WagerTransaction } from '../domain/wager-transaction.ts';
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from '../domain/wager-transaction-kind.ts';
import { recordSettlementEffects } from './settlement-effects.ts';
import { toResultView, type WagerTransactionResultView } from './wager-transaction-views.ts';

export interface ProcessWagerTransactionCommand {
  /** Fonte da verdade da idempotência (header HTTP ou campo da mensagem SQS). */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  context: RequestContext;
  /** Presente quando a entrada é a fila: deduplicação persistente por (consumerName, messageId) (§10). */
  inbox?: { consumerName: string; messageId: string } | undefined;
}

/**
 * Caso de uso único para HTTP e SQS (§10). Numa só transação SQL: lock da wallet,
 * idempotência, regras de negócio, transação, ledger, saldo e outbox (§6.5, §11).
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResultView> {
    if (command.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidRequestError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved for internal transactions`);
    }
    const kind = parseKind(command.kind);
    const money = moneyFromInput(command.money);
    const payloadHash = computePayloadHash(payloadFields(command));
    try {
      return await this.uow.run((scope) => this.processWithInbox(scope, command, kind, money, payloadHash));
    } catch (error) {
      if (error instanceof UniqueViolationError && error.duplicate === 'WAGER_TRANSACTION') {
        // Corrida residual: a mesma identidade foi comitada por outra transação (ex.: payloads
        // com walletIds diferentes travam wallets diferentes). Relê e devolve replay ou conflito.
        return this.uow.run(async (scope) => {
          const existing = await findExisting(scope, command);
          if (existing === undefined) throw error;
          return replayOrConflict(existing, command, payloadHash);
        });
      }
      throw error;
    }
  }

  /**
   * Inbox, alteração financeira, ledger e outbox na mesma transação SQL (§6.5): a linha da
   * inbox só existe se o processamento comitou. Redelivery de mensagem já processada devolve
   * o resultado gravado sem disputar o lock da wallet.
   */
  private async processWithInbox(
    scope: TransactionScope,
    command: ProcessWagerTransactionCommand,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResultView> {
    if (command.inbox === undefined) return this.process(scope, command, kind, money, payloadHash);

    const received = InboxMessage.receive({
      consumerName: command.inbox.consumerName,
      messageId: command.inbox.messageId,
      payloadHash,
      receivedAt: this.clock.now(),
    });
    if (!(await scope.inbox.tryReceive(received))) {
      return redelivered(scope, command, payloadHash);
    }
    const result = await this.process(scope, command, kind, money, payloadHash);
    received.markProcessed(this.clock.now());
    await scope.inbox.markProcessed(received);
    return result;
  }

  private async process(
    scope: TransactionScope,
    command: ProcessWagerTransactionCommand,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResultView> {
    // 1. Lock por wallet: operações da mesma wallet serializam; wallets diferentes seguem em paralelo (§8).
    const wallet = await scope.wallets.lockForUpdate(command.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(command.walletId);

    // 2. Idempotência persistente, sob o lock: duplicatas concorrentes enxergam a linha comitada.
    const existing = await findExisting(scope, command);
    if (existing !== undefined) return replayOrConflict(existing, command, payloadHash);

    // 3. Nova transação + referência.
    const at = this.clock.now();
    const transaction = createTransaction({ command, kind, money, payloadHash, id: this.ids.next(), at });
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await scope.transactions.findByProviderExternalId(transaction.providerId, transaction.referenceExternalTransactionId);
    const referenceAlreadyReversed = reference === undefined ? false : await scope.transactions.hasProcessedReversal(reference.id);

    // 4. Regras de negócio (domínio puro).
    const versionBefore = wallet.version;
    const result = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
      referenceRetry: this.referenceRetry,
    });

    // 5. Persistência explícita: só o que mudou. A referência lida nunca é regravada.
    await scope.transactions.insert(transaction);
    await recordSettlementEffects(scope, {
      transaction,
      wallet,
      versionBefore,
      result,
      nextEventContext: () => eventContext(this.ids, at, command.context),
      announcePendingReference: true,
    });

    return toResultView(transaction, false);
  }
}

/** Mensagem já consumida: mesmo conteúdo → resultado original; conteúdo diferente → conflito permanente. */
async function redelivered(
  scope: TransactionScope,
  command: ProcessWagerTransactionCommand,
  payloadHash: string,
): Promise<WagerTransactionResultView> {
  const inbox = command.inbox;
  if (inbox === undefined) throw new Error('redelivered() requires an inbox context');
  const recorded = await scope.inbox.find(inbox.consumerName, inbox.messageId);
  if (recorded !== undefined && !recorded.matchesPayload(payloadHash)) {
    throw new MessageConflictError(inbox.consumerName, inbox.messageId);
  }
  const existing = await findExisting(scope, command);
  if (existing === undefined) {
    throw new Error(`inbox message ${inbox.messageId} is recorded but its transaction was not found`);
  }
  return replayOrConflict(existing, command, payloadHash);
}

async function findExisting(
  scope: TransactionScope,
  command: ProcessWagerTransactionCommand,
): Promise<WagerTransaction | undefined> {
  return (
    (await scope.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
    (await scope.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId))
  );
}

/** Mesma key + mesmo payload → resultado original. Qualquer divergência → conflito (§9). */
function replayOrConflict(
  existing: WagerTransaction,
  command: ProcessWagerTransactionCommand,
  payloadHash: string,
): WagerTransactionResultView {
  if (existing.idempotencyKey !== command.idempotencyKey) {
    throw new IdempotencyConflictError(
      `transaction ${command.providerId}/${command.externalTransactionId} was already submitted with another idempotency key`,
      existing.id,
    );
  }
  if (!existing.matchesPayload(payloadHash)) {
    throw new IdempotencyConflictError(
      `idempotency key ${command.idempotencyKey} was already used with a different payload`,
      existing.id,
    );
  }
  return toResultView(existing, true);
}

function createTransaction(input: {
  command: ProcessWagerTransactionCommand;
  kind: WagerTransactionKind;
  money: Money;
  payloadHash: string;
  id: string;
  at: Date;
}): WagerTransaction {
  const { command } = input;
  try {
    return WagerTransaction.create({
      id: input.id,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: input.at,
    });
  } catch (error) {
    if (error instanceof DomainError) throw new InvalidRequestError(error.message);
    throw error;
  }
}

function payloadFields(command: ProcessWagerTransactionCommand): WagerPayloadFields {
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
}

function parseKind(kind: string): WagerTransactionKind {
  const match = SUBMITTABLE_KINDS.find((candidate) => candidate === kind);
  if (match === undefined) {
    throw new InvalidRequestError(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
  return match;
}

