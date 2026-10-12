import { describe, expect, test } from 'bun:test';
import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { TransientInfrastructureError, UniqueViolationError } from '../../src/shared/application/application-error.ts';
import { translateError } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work.ts';

describe('tradução de erros de infraestrutura', () => {
  test('pool de conexões esgotado → falha transitória (503), nunca espera infinita', () => {
    expect(translateError(new Error('timeout exceeded when trying to connect'))).toBeInstanceOf(TransientInfrastructureError);
  });

  test('erro de rede → falha transitória', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(translateError(refused)).toBeInstanceOf(TransientInfrastructureError);
  });

  test('classes de SQLSTATE de conexão/indisponibilidade → falha transitória (nunca FAILED por engano)', () => {
    for (const code of ['08006', '08003', '53100', '53300', '57P01', '57014', '58030', '55P03', '40P01', '40001']) {
      const error = new DriverException(Object.assign(new Error(`sqlstate ${code}`), { code }));
      expect(translateError(error)).toBeInstanceOf(TransientInfrastructureError);
    }
  });

  test('conexão derrubada pelo driver sem código → falha transitória', () => {
    expect(translateError(new Error('Connection terminated unexpectedly'))).toBeInstanceOf(TransientInfrastructureError);
  });

  test('violação de constraint (bug) não é transitória', () => {
    const error = new DriverException(Object.assign(new Error('check violation'), { code: '23514' }));
    expect(translateError(error)).toBe(error);
  });

  test.each([
    ['wager_transactions_idempotency_key_uq', 'WAGER_TRANSACTION'],
    ['wager_transactions_provider_external_uq', 'WAGER_TRANSACTION'],
    ['wallets_player_currency_uq', 'WALLET'],
    ['wager_transactions_single_reversal_uq', undefined], // não é identidade de negócio: bug → 500
  ])('unicidade violada em %s → identidade %p (a aplicação não conhece nomes de constraints)', (constraint, duplicate) => {
    const error = new UniqueConstraintViolationException(Object.assign(new Error('duplicate key'), { code: '23505', constraint }));
    const translated = translateError(error);
    expect(translated).toBeInstanceOf(UniqueViolationError);
    expect(translated).toMatchObject({ constraint, duplicate });
  });

  test('erro desconhecido passa adiante intacto', () => {
    const error = new Error('boom');
    expect(translateError(error)).toBe(error);
  });
});
