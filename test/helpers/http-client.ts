import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface SubmitBody {
  transactionId: string;
  status: string;
  balance?: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
  retryable?: boolean;
  code?: string;
}

/** Payload de aposta com ids aleatórios, para HTTP (corpo) e SQS (`data`, com a idempotency key). */
export function wager(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Cliente HTTP da API (via `fetch`), usado pelo app em processo e pelas instâncias reais do cluster. */
export class HttpClient {
  constructor(readonly baseUrl: string) {}

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : {}) as T, headers: response.headers };
  }

  async createWallet(amount: string, currency = 'BRL', playerId: string = randomUUID()) {
    const response = await this.request<{ id: string; playerId: string }>('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency },
    });
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId };
  }

  /** `idempotencyKey: null` omite o header. */
  submit(payload: WagerPayload, idempotencyKey: string | null = `${payload.providerId}:${payload.externalTransactionId}`) {
    return this.request<SubmitBody>(
      'POST',
      '/wagering/transactions',
      payload,
      idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey },
    );
  }
}
