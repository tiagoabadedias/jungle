/**
 * Taxonomia estável de falhas (§7.2). Cada código diz ao provedor se pode reenviar,
 * se precisa corrigir o payload ou se deve desistir.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InfraPermanentFailure = 'INFRA_PERMANENT_FAILURE',
}

export type ProviderAction = 'GIVE_UP' | 'FIX_PAYLOAD' | 'ESCALATE';

export interface FailureCodeInfo {
  /** Reenviar o mesmo payload pode ter outro resultado? */
  readonly retryable: boolean;
  readonly action: ProviderAction;
  readonly description: string;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeInfo>> = Object.freeze({
  [FailureCode.InsufficientFunds]: {
    retryable: false,
    action: 'GIVE_UP',
    description: 'Saldo insuficiente para a aposta.',
  },
  [FailureCode.ReversalInsufficientFunds]: {
    retryable: false,
    action: 'ESCALATE',
    description: 'A reversão deixaria o saldo negativo; exige tratamento operacional.',
  },
  [FailureCode.CurrencyMismatch]: {
    retryable: false,
    action: 'FIX_PAYLOAD',
    description: 'A moeda da operação difere da moeda da wallet.',
  },
  [FailureCode.WalletPlayerMismatch]: {
    retryable: false,
    action: 'FIX_PAYLOAD',
    description: 'A wallet informada não pertence ao player informado.',
  },
  [FailureCode.ReferenceNotFound]: {
    retryable: false,
    action: 'GIVE_UP',
    description: 'A transação referenciada não chegou dentro do limite de tentativas.',
  },
  [FailureCode.ReferenceNotProcessed]: {
    retryable: false,
    action: 'GIVE_UP',
    description: 'A transação referenciada foi rejeitada ou falhou.',
  },
  [FailureCode.ReferenceMismatch]: {
    retryable: false,
    action: 'FIX_PAYLOAD',
    description: 'A referência pertence a outro player, wallet, moeda ou rodada.',
  },
  [FailureCode.InvalidReferenceKind]: {
    retryable: false,
    action: 'FIX_PAYLOAD',
    description: 'O tipo da transação referenciada não pode ser alvo desta operação.',
  },
  [FailureCode.ReferenceAmountMismatch]: {
    retryable: false,
    action: 'FIX_PAYLOAD',
    description: 'O valor da reversão difere do valor da transação referenciada.',
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    retryable: false,
    action: 'GIVE_UP',
    description: 'A transação referenciada já foi revertida.',
  },
  [FailureCode.InfraPermanentFailure]: {
    retryable: false,
    action: 'ESCALATE',
    description: 'Erro permanente de infraestrutura; transação registrada como FAILED para auditoria.',
  },
});
