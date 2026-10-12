import { InvariantViolationError } from './domain-error.ts';

export interface ExponentialBackoffProps {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Backoff exponencial determinístico: base · 2^tentativa, limitado ao teto.
 * Jitter, quando desejado, é aplicado pelo worker (infra) para manter o domínio previsível.
 */
export class ExponentialBackoff {
  private constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
  ) {}

  static create(props: ExponentialBackoffProps): ExponentialBackoff {
    if (!Number.isSafeInteger(props.baseDelayMs) || props.baseDelayMs <= 0) {
      throw new InvariantViolationError('baseDelayMs must be a positive integer');
    }
    if (!Number.isSafeInteger(props.maxDelayMs) || props.maxDelayMs < props.baseDelayMs) {
      throw new InvariantViolationError('maxDelayMs must be an integer >= baseDelayMs');
    }
    return new ExponentialBackoff(props.baseDelayMs, props.maxDelayMs);
  }

  /** Atraso antes da próxima tentativa. O expoente é o número de falhas anteriores (negativo conta como 0). */
  delayFor(failedAttempts: number): number {
    if (!Number.isSafeInteger(failedAttempts)) throw new InvariantViolationError('failedAttempts must be an integer');
    const exponent = failedAttempts < 0 ? 0 : failedAttempts;
    const delay = this.baseDelayMs * 2 ** exponent;
    return delay > this.maxDelayMs ? this.maxDelayMs : delay;
  }

  /** Atraso em segundos inteiros, arredondado para cima (APIs como a visibilidade do SQS). */
  delaySecondsFor(failedAttempts: number): number {
    const delayMs = this.delayFor(failedAttempts);
    const remainder = delayMs % 1000;
    return (delayMs - remainder) / 1000 + (remainder === 0 ? 0 : 1);
  }

  nextAttemptAt(now: Date, failedAttempts: number): Date {
    return new Date(now.getTime() + this.delayFor(failedAttempts));
  }
}
