import { errorMessage } from '../../application/error-message.ts';

export interface WorkerLogger {
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn?(message: unknown, ...optionalParams: unknown[]): void;
}

/**
 * Prazo do `stop()`. O shutdown do Nest para os módulos em sequência (consumer + worker de
 * referências em paralelo, depois o publisher): 20 s de drenagem do consumer + 5 s cabem nos
 * 30 s do `stop_grace_period`.
 */
export const WORKER_STOP_TIMEOUT_MS = 5_000;

/**
 * Loop de polling com parada graciosa. Enquanto `tick` encontra trabalho, roda de novo em
 * seguida (drena o backlog); quando não há trabalho, dorme `intervalMs`. `stop()` acorda o
 * loop e espera o tick em andamento terminar, até `stopTimeoutMs` — nada é interrompido no meio
 * de uma transação. Se o prazo estourar, o shutdown segue: a transação aberta é desfeita quando
 * o processo sai e o item volta a ficar disponível para outra instância.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: WorkerLogger,
    private readonly stopTimeoutMs: number = WORKER_STOP_TIMEOUT_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    if (this.loop === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), this.stopTimeoutMs);
    });
    const outcome = await Promise.race([this.loop.then(() => 'STOPPED' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'TIMEOUT') this.logger.warn?.({ msg: `${this.name} stop timed out`, timeoutMs: this.stopTimeoutMs });
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let work = 0;
      try {
        work = await this.tick();
      } catch (error) {
        this.logger.error({ msg: `${this.name} tick failed`, error: errorMessage(error) });
      }
      if (this.running && work === 0) await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
