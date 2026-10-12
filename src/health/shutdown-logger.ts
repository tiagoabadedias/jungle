import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

/** Registra o encerramento — prova de que o sinal chegou ao processo (enableShutdownHooks). */
@Injectable()
export class ShutdownLogger implements OnApplicationShutdown {
  private readonly logger = new Logger('Lifecycle');

  onApplicationShutdown(signal?: string): void {
    this.logger.log({ msg: 'shutdown', signal, pid: process.pid });
  }
}
