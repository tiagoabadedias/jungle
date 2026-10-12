import { InvalidTransactionStateError, InvariantViolationError } from '../../shared/domain/domain-error.ts';
import type { ExponentialBackoff } from '../../shared/domain/exponential-backoff.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection, oppositeDirection } from '../../wallet/domain/ledger-direction.ts';
import { computePayloadHash } from './payload-hash.ts';
import { ALLOWED_REFERENCE_KINDS, WagerTransactionKind } from './wager-transaction-kind.ts';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status.ts';

/** `providerId` e `gameId` reservados para a transação OPENING (interna); também prefixa a idempotency key dela. */
export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  observedBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export interface ReferenceRetryPolicy {
  maxAttempts: number;
  backoff: ExponentialBackoff;
}

export type ReferenceRetryOutcome = 'SCHEDULED' | 'EXHAUSTED';

/**
 * Transação de aposta (§6.3). Transições válidas:
 *
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED  (ou permanece, reagendada)
 *   PROCESSED / REJECTED / FAILED → nenhuma (InvalidTransactionStateError)
 *
 * `observedBalance` guarda o saldo observado na decisão, para que o replay devolva o
 * resultado original, inclusive para REJECTED, que não tem ledger (§7.7).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Transação submetida por um provedor. Nasce em PENDING e valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvariantViolationError('OPENING is internal and cannot be submitted');
    }
    WagerTransaction.assertReferenceRules(props.kind, props.referenceExternalTransactionId);
    WagerTransaction.assertAmount(props.kind, props.money);
    return WagerTransaction.newPending(props);
  }

  /** Crédito interno de abertura da wallet (§9). Nasce PROCESSED. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('OPENING requires a positive amount');
    }
    const externalTransactionId = `opening:${props.walletId}`;
    const fields = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: externalTransactionId,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
    };
    const transaction = WagerTransaction.newPending({
      ...fields,
      id: props.id,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: computePayloadHash(fields),
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    });
    transaction.markProcessed(undefined, props.at, props.money);
    return transaction;
  }

  /** Reconstrução a partir da persistência — não revalida transições (§6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : new Date(state.processedAt.getTime()),
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt === undefined ? undefined : new Date(state.nextReferenceAttemptAt.getTime()),
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static assertReferenceRules(kind: WagerTransactionKind, reference: string | undefined): void {
    // Referência vazia não é "ausente": seria guardada como "" e ficaria aguardando
    // uma transação inexistente até o TTL. É payload inválido.
    if (reference !== undefined && reference.trim().length === 0) {
      throw new InvariantViolationError('referenceExternalTransactionId must not be empty');
    }
    const hasReference = reference !== undefined;
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !hasReference) {
      throw new InvariantViolationError(`${kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && ALLOWED_REFERENCE_KINDS[kind] === undefined) {
      throw new InvariantViolationError(`${kind} does not accept referenceExternalTransactionId`);
    }
  }

  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new InvariantViolationError('amount must not be negative');
    }
    // Movimentos de saldo precisam de valor > 0: um lançamento zero não altera saldo,
    // o que violaria "toda alteração de saldo tem lançamento e vice-versa" (§6.2).
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new InvariantViolationError(`${kind} requires an amount greater than zero`);
    }
  }

  // ---- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt === undefined ? undefined : new Date(this._nextReferenceAttemptAt.getTime());
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
    this._observedBalance = balanceAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(observedBalance: Money, nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference is only valid from PENDING (current: ${this._status})`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
  }

  /**
   * Registra uma tentativa sem sucesso de resolver a referência. Reagenda com backoff
   * ou, esgotado o limite, rejeita com REFERENCE_NOT_FOUND (§7.1).
   */
  registerReferenceAttempt(
    now: Date,
    policy: ReferenceRetryPolicy,
    observedBalance: Money,
  ): ReferenceRetryOutcome {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `registerReferenceAttempt is only valid from PENDING_REFERENCE (current: ${this._status})`,
      );
    }
    this._referenceAttempts += 1;
    if (this._referenceAttempts >= policy.maxAttempts) {
      this.reject(FailureCode.ReferenceNotFound, now, observedBalance);
      return 'EXHAUSTED';
    }
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = policy.backoff.nextAttemptAt(now, this._referenceAttempts);
    return 'SCHEDULED';
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvariantViolationError('ROLLBACK direction depends on the referenced transaction');
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not move balance and has no ledger direction');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${transition}: transaction ${this.id} is ${this._status}`);
    }
  }
}
