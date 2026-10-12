/**
 * Texto de erro seguro para log. O conversor de exceções do MikroORM anexa à mensagem o
 * `detail`/`hint` do PostgreSQL ("\n - detail: Failing row contains (…)"), que traz a linha
 * inteira que falhou, com ids e valores monetários (§12: logs sem payloads financeiros).
 */
export function withoutDriverDetail(text: string): string {
  return text.replace(/\n - (?:detail|hint): [^\n]*/g, '');
}

export function errorMessage(error: unknown): string {
  return withoutDriverDetail(error instanceof Error ? error.message : String(error));
}

/** `code` estável do erro (erros de aplicação/domínio, SQLSTATE, códigos de rede), se houver. */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
