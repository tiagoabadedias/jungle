import { DomainError } from '../domain/domain-error.ts';
import { Money, type MoneyProps } from '../domain/money.ts';
import { InvalidRequestError } from './application-error.ts';

/** Valor monetário vindo de fora (HTTP/SQS): formato inválido é erro de requisição (400 / DLQ), não de domínio. */
export function moneyFromInput(props: MoneyProps): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof DomainError) throw new InvalidRequestError(error.message);
    throw error;
  }
}
