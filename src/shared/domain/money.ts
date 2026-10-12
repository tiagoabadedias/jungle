import { assertCurrencyCode, MINOR_UNIT_SCALE, MINOR_UNITS_PER_MAJOR } from './currency.ts';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error.ts';

/** Contrato de entrada/saída (DTO): valor como string decimal com escala fixa. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Formato aceito em contratos de entrada: sem sinal, sem zeros à esquerda, exatamente
 * 2 casas. Rejeita NaN, Infinity, notação científica, hex, separadores e string vazia.
 */
const INPUT_AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d*)\\.(\\d{${MINOR_UNIT_SCALE}})$`);

/** Maior valor representável na coluna `bigint` do PostgreSQL. */
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

/**
 * Value Object monetário imutável. Internamente usa `bigint` em unidades menores
 * (centavos): "25.00" ↔ 2500n. Nunca passa por `number` (§5.1).
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Entrada de contrato (HTTP, SQS): valida formato e rejeita negativos. */
  static from(props: MoneyProps): Money {
    assertCurrencyCode(props.currency);
    const amount: unknown = props.amount;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(`amount must be a decimal string with ${MINOR_UNIT_SCALE} decimal places`);
    }
    const match = INPUT_AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `amount must be a non-negative decimal string with exactly ${MINOR_UNIT_SCALE} decimal places, e.g. "25.00"`,
      );
    }
    const [, whole = '0', fraction = '0'] = match;
    const minor = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(fraction);
    if (minor > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError('amount exceeds the supported range');
    }
    return new Money(minor, props.currency);
  }

  /** Reconstrução a partir de unidades menores (persistência, resultados de agregação). */
  static fromMinorUnits(minor: bigint, currency: string): Money {
    assertCurrencyCode(currency);
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  /** Valor em unidades menores, para persistência. */
  get minorUnits(): bigint {
    return this.minor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  hasSameCurrencyAs(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    const negative = this.minor < 0n;
    const absolute = negative ? -this.minor : this.minor;
    const whole = absolute / MINOR_UNITS_PER_MAJOR;
    const fraction = (absolute % MINOR_UNITS_PER_MAJOR).toString().padStart(MINOR_UNIT_SCALE, '0');
    return { amount: `${negative ? '-' : ''}${whole.toString()}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
