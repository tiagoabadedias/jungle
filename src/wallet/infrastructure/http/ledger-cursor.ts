import { InvalidRequestError } from '../../../shared/application/application-error.ts';
import type { LedgerCursor } from '../../application/ports/ledger.repository.ts';

/**
 * Cursor opaco e estável (§9): base64url de `{ t, id }` — posição (createdAt, id) do último
 * lançamento entregue. Estável porque o ledger é append-only e a ordenação é total.
 * Os timestamps são gravados com precisão de milissegundos pela aplicação, então o `Date`
 * do JS representa a posição sem perda.
 */
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(value: string): LedgerCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 't' in parsed && 'id' in parsed) {
      const { t, id } = parsed;
      const createdAt = typeof t === 'string' ? new Date(t) : undefined;
      if (createdAt !== undefined && !Number.isNaN(createdAt.getTime()) && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) {
        return { createdAt, id };
      }
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError('cursor is invalid');
}
