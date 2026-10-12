import { InvalidTransactionStateError } from '../../shared/domain/domain-error.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import type { ReferenceRetryPolicy, WagerTransaction } from './wager-transaction.ts';
import { ALLOWED_REFERENCE_KINDS } from './wager-transaction-kind.ts';
import { WagerTransactionStatus } from './wager-transaction-status.ts';

export interface SettlementInput {
  /** Transação em PENDING (nova) ou PENDING_REFERENCE (reprocessamento). */
  transaction: WagerTransaction;
  /** Wallet da transação, já travada pela camada de aplicação. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ausente. */
  reference: WagerTransaction | undefined;
  /** Já existe reversão PROCESSED apontando para a referência? */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
  referenceRetry: ReferenceRetryPolicy;
}

export type SettlementResult =
  | { outcome: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { outcome: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { outcome: WagerTransactionStatus.PendingReference };

/**
 * Aplica as regras de negócio do §7 a uma transação, mantendo saldo e ledger consistentes.
 * Puro: não faz I/O. A camada de aplicação carrega as entradas (com lock da wallet) e
 * persiste as entidades alteradas.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementResult {
  const { transaction, wallet, at } = input;
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`transaction ${transaction.id} is already ${transaction.status}`);
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidTransactionStateError(`transaction ${transaction.id} does not belong to wallet ${wallet.id}`);
  }

  if (transaction.money.currency !== wallet.currency) {
    return reject(input, FailureCode.CurrencyMismatch);
  }
  if (transaction.playerId !== wallet.playerId) {
    return reject(input, FailureCode.WalletPlayerMismatch);
  }

  let reference: WagerTransaction | undefined;
  if (transaction.hasReference()) {
    const resolved = input.reference;
    // Referência ausente ou ainda não decidida → aguarda (§7.8).
    if (resolved === undefined || resolved.status === WagerTransactionStatus.Pending || resolved.status === WagerTransactionStatus.PendingReference) {
      return awaitReference(input);
    }
    const violation = referenceViolation(transaction, resolved, input.referenceAlreadyReversed);
    if (violation !== undefined) {
      return reject(input, violation);
    }
    reference = resolved;
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, at, wallet.balance);
    return { outcome: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    // Reversão sem saldo é operacionalmente diferente de aposta sem saldo (§7.9).
    const code = transaction.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
    return reject(input, code);
  }

  const ledgerEntry = wallet.move(direction, {
    money: transaction.money,
    transactionId: transaction.id,
    entryId: input.ledgerEntryId,
    at,
  });
  transaction.markProcessed(reference?.id, at, wallet.balance);
  return { outcome: WagerTransactionStatus.Processed, ledgerEntry };
}

/** Valida a referência já resolvida (§7.2–§7.5). Retorna o código da violação ou undefined. */
function referenceViolation(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  const sameOwnership =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameOwnership) return FailureCode.ReferenceMismatch;

  const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
  if (!allowedKinds.includes(reference.kind)) return FailureCode.InvalidReferenceKind;

  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

  if (transaction.isReversal()) {
    if (!reference.money.equals(transaction.money)) return FailureCode.ReferenceAmountMismatch;
    // Uma referência é revertida no máximo uma vez, por qualquer kind (ARCHITECTURE §12, interpretação 1).
    if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}

function reject(input: SettlementInput, code: FailureCode): SettlementResult {
  input.transaction.reject(code, input.at, input.wallet.balance);
  return { outcome: WagerTransactionStatus.Rejected, failureCode: code };
}

function awaitReference(input: SettlementInput): SettlementResult {
  const { transaction, wallet, at, referenceRetry } = input;
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference(wallet.balance, referenceRetry.backoff.nextAttemptAt(at, 0));
    return { outcome: WagerTransactionStatus.PendingReference };
  }
  const retry = transaction.registerReferenceAttempt(at, referenceRetry, wallet.balance);
  if (retry === 'EXHAUSTED') {
    return { outcome: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceNotFound };
  }
  return { outcome: WagerTransactionStatus.PendingReference };
}

