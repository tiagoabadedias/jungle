/**
 * Base dos erros de domínio. `code` é estável e legível por máquina; a camada HTTP/SQS
 * traduz cada subclasse para um status/ação sem interpretar a mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário inválido em contrato de entrada (formato, escala, sinal, moeda). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

/** Débito que tornaria o saldo negativo. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`insufficient funds in wallet ${walletId}`);
  }
}

/** Dados ou chamadas que violam invariantes do domínio (criação, transições, eventos, políticas). */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}

/** Transição de estado inválida — erro de programação, não caminho de negócio (§6.3). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(message: string) {
    super(message);
  }
}
