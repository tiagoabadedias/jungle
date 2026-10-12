import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { withoutDriverDetail } from '../../application/error-message.ts';
import { currentLogContext } from './log-context.ts';

/**
 * Logs estruturados em JSON (pino) direto no stdout, sem transport (transports travam o
 * shutdown sob Bun). O `mixin` injeta correlationId/messageId/transactionId/walletId/providerId
 * do escopo atual em toda linha. A redação é uma rede de segurança: o código não loga
 * payloads, mas qualquer campo monetário ou de credencial que escape é censurado (§12).
 * Pelo mesmo motivo, o `detail` do PostgreSQL (linha inteira que falhou) sai de mensagens e stacks.
 */
export const REDACTED_PATHS = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'payload',
  'body',
  'data',
  '*.money',
  '*.amount',
  '*.balance',
  '*.balanceBefore',
  '*.balanceAfter',
  '*.initialBalance',
  '*.payload',
  '*.body',
  'headers.authorization',
  '*.headers.authorization',
  'password',
  '*.password',
  'secret',
  '*.secret',
];

export function createRootLogger(level: string, destination?: DestinationStream): PinoLogger {
  const options = {
    level,
    base: { service: 'wagering-processor' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    messageKey: 'msg',
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  } satisfies pino.LoggerOptions;
  return destination === undefined ? pino(options) : pino(options, destination);
}

type Level = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal';

/** Adapta o pino ao `LoggerService` do NestJS: `new Logger('Contexto')` passa a sair em JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly root: PinoLogger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('trace', message, optional);
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, optional);
  }

  private write(level: Level, message: unknown, optional: unknown[]): void {
    // Convenção do Nest: o último parâmetro string é o contexto; no error, o anterior é o stack.
    const params = [...optional];
    const context = typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const stack = level === 'error' && typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const meta: Record<string, unknown> = {};
    if (context !== undefined) meta['context'] = context;
    if (stack !== undefined) meta['stack'] = withoutDriverDetail(stack);

    if (typeof message === 'object' && message !== null && !(message instanceof Error)) {
      const { msg, ...fields } = message as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'string') fields[key] = withoutDriverDetail(value);
      }
      this.root[level]({ ...meta, ...fields }, typeof msg === 'string' ? msg : '');
      return;
    }
    if (message instanceof Error) {
      const text = withoutDriverDetail(message.message);
      const errorStack = message.stack === undefined ? undefined : withoutDriverDetail(message.stack);
      this.root[level]({ ...meta, err: { type: message.name, message: text, stack: errorStack } }, text);
      return;
    }
    this.root[level](meta, withoutDriverDetail(String(message)));
  }
}

export const ROOT_LOGGER = Symbol('RootLogger');
