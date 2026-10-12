import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/shared/domain/domain-error.ts';
import { Money, type MoneyProps } from '../../../src/shared/domain/money.ts';
import { brl } from '../fixtures.ts';

describe('Money.from — contrato de entrada', () => {
  test.each([
    ['0.00', 0n],
    ['0.01', 1n],
    ['25.00', 2500n],
    ['1000.00', 100000n],
    ['90071992547409.93', 9007199254740993n], // acima de Number.MAX_SAFE_INTEGER em centavos
  ])('aceita "%s" como %p centavos', (amount, minor) => {
    expect(Money.from({ amount, currency: 'BRL' }).minorUnits).toBe(minor);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1.00e2'],
    [''],
    ['25'],
    ['25.0'],
    ['25.001'],
    ['25.005'], // rejeitado, nunca arredondado
    ['-1.00'],
    ['+5.00'],
    ['.50'],
    ['01.00'],
    ['0x1A'],
    ['1_000.00'],
    ['1,000.00'],
    [' 1.00'],
    ['1.00 '],
    ['25,00'],
  ])('rejeita amount "%s"', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (ex.: number vindo de JSON)', () => {
    const props = { amount: 25, currency: 'BRL' } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test('rejeita valor acima do limite da coluna bigint', () => {
    expect(() => Money.from({ amount: '92233720368547758.08', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(Money.from({ amount: '92233720368547758.07', currency: 'BRL' }).minorUnits).toBe(9_223_372_036_854_775_807n);
  });

  test.each([['brl'], ['BR'], ['BRLX'], [''], ['12A']])('rejeita moeda "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata e imutável', () => {
  test('0.10 + 0.20 = 0.30 exatamente (onde float daria 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  test('add, subtract e negate retornam novas instâncias', () => {
    const a = brl('100.00');
    const b = brl('80.00');
    expect(a.subtract(b).toJSON().amount).toBe('20.00');
    expect(b.subtract(a).toJSON().amount).toBe('-20.00');
    expect(a.negate().toJSON().amount).toBe('-100.00');
    expect(a.add(b).toJSON().amount).toBe('180.00');
    expect(a.toJSON().amount).toBe('100.00');
  });

  test('instância é congelada', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
  });

  test('consultas de sinal e comparação', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.00').equals(brl('80.00'))).toBe(true);
    expect(brl('80.00').equals(Money.from({ amount: '80.00', currency: 'USD' }))).toBe(false);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money — serialização', () => {
  test.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [50n, '0.50'],
    [2500n, '25.00'],
    [-5n, '-0.05'],
    [9007199254740993n, '90071992547409.93'],
  ])('fromMinorUnits(%p) serializa como "%s"', (minor, amount) => {
    expect(Money.fromMinorUnits(minor, 'BRL').toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  test('ida e volta string → bigint → string preserva o valor', () => {
    for (const amount of ['0.00', '0.01', '0.99', '1.00', '123456789.12']) {
      expect(Money.from({ amount, currency: 'BRL' }).toJSON().amount).toBe(amount);
    }
  });

  test('JSON.stringify usa toJSON (MoneyProps com string), nunca bigint', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test('toString', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});
