import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

export interface BackgroundWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface ManagedWorker {
  /** Desligado por configuração: não inicia (o `stop` é inócuo). */
  enabled: boolean;
  worker: BackgroundWorker;
}

/**
 * Inicia os workers de um módulo no bootstrap e, no shutdown, espera todos terminarem o
 * trabalho em andamento (em paralelo), antes de o pool do banco fechar (`onApplicationShutdown`).
 * Cada módulo declara uma subclasse fina que injeta os seus workers.
 */
export abstract class BackgroundWorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  protected constructor(private readonly workers: readonly ManagedWorker[]) {}

  onApplicationBootstrap(): void {
    for (const { enabled, worker } of this.workers) if (enabled) worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map(({ worker }) => worker.stop()));
  }
}
