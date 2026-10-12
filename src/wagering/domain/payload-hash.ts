import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../shared/domain/money.ts';

/**
 * Subconjunto de negócio que entra no hash (§9). Header `Idempotency-Key`, `messageId`,
 * `occurredAt` e demais metadados de transporte ficam de fora.
 */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

/**
 * JSON canônico: chaves de objetos ordenadas recursivamente (ordem de code units UTF-16),
 * propriedades `undefined` omitidas, sem espaços. Arrays preservam a ordem.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const item = value[key];
        return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
      });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** payloadHash = SHA-256 (hex, minúsculo) do JSON canônico dos campos de negócio. */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: { [key: string]: CanonicalValue | undefined } = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset), 'utf8').digest('hex');
}
