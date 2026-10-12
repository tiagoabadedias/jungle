import { InvalidMoneyError } from './domain-error.ts';

/**
 * Política de moeda. O §6.1 fixa a escala dos contratos em 2 casas para toda moeda,
 * então a escala é única. Suportar expoentes ISO-4217 por moeda (JPY 0, KWD 3)
 * exigiria mudar o contrato de entrada — fora de escopo, documentado no ARCHITECTURE.md.
 */
export const MINOR_UNIT_SCALE = 2;
export const MINOR_UNITS_PER_MAJOR = 10n ** BigInt(MINOR_UNIT_SCALE);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function assertCurrencyCode(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError('currency must be an ISO-4217 code with 3 uppercase letters');
  }
}
