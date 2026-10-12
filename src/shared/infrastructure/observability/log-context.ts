import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de rastreio exigidos pelo §12 em todo log da operação. Nunca valores monetários. */
export interface LogContext {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Abre um escopo de contexto (requisição HTTP, mensagem SQS, item de worker). O objeto
 * passado é o próprio escopo: quem o criou enxerga os campos atribuídos depois.
 */
export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run(context, work);
}

/** Enriquece o escopo atual à medida que os ids ficam conhecidos (ex.: transactionId após processar). */
export function assignLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current === undefined) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) current[key as keyof LogContext] = value;
  }
}

export function currentLogContext(): LogContext {
  return { ...(storage.getStore() ?? {}) };
}
