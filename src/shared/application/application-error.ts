/**
 * Erros da camada de aplicação. Cada um representa uma situação que o provedor precisa
 * distinguir sem interpretar mensagem (§9): o adapter HTTP/SQS mapeia por classe.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Payload inválido segundo as regras de domínio (formato de dinheiro, referência, OPENING…). → 400 */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`wager transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma idempotency key (ou mesmo id externo) com payload diferente: conflito, não replay. → 409 */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
  }
}

/** Banco/fila indisponível, lock não obtido a tempo: reenviar pode dar certo. → 503 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Identidades de negócio cuja unicidade o banco garante, para a aplicação reagir a uma
 * duplicata sem conhecer nomes de constraints:
 *  - WAGER_TRANSACTION: idempotency key ou (providerId, externalTransactionId) já comitados;
 *  - WALLET: wallet do mesmo player na mesma moeda.
 */
export type DuplicateIdentity = 'WAGER_TRANSACTION' | 'WALLET';

/**
 * Violação de unicidade traduzida pela infraestrutura. `duplicate` diz qual identidade de
 * negócio colidiu (ausente = constraint que a aplicação deveria ter evitado: bug).
 * `constraint` fica só para diagnóstico.
 */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(
    readonly constraint: string,
    readonly duplicate?: DuplicateIdentity,
    override readonly cause?: unknown,
  ) {
    super(`unique constraint ${constraint} violated`);
  }
}

/** Mesmo messageId (inbox) com conteúdo diferente: não é redelivery. Erro permanente → DLQ. */
export class MessageConflictError extends ApplicationError {
  readonly code = 'MESSAGE_CONFLICT';

  constructor(consumerName: string, messageId: string) {
    super(`message ${messageId} was already consumed by ${consumerName} with a different payload`);
  }
}
