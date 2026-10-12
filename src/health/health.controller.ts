import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Controller, Get, Inject, Injectable, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../shared/infrastructure/sqs/sqs-client.ts';

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = 'up' | 'down';

interface StatusWritableResponse {
  status(code: number): unknown;
}

/** Marca o início do shutdown: a readiness passa a responder 503 para o balanceador drenar o tráfego. */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => resolve('down'), CHECK_TIMEOUT_MS);
  });
  const result = await Promise.race([probe().then(() => 'up' as const, () => 'down' as const), timeout]);
  clearTimeout(timer);
  return result;
}

/** Health checks separados (§9, §12). Abertos, sem autenticação (§2). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(ShutdownState) private readonly shutdown: ShutdownState,
  ) {}

  /** Liveness: processo vivo. Não consulta dependências (reiniciar não resolve banco fora). */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis e o processo não está encerrando. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusWritableResponse) {
    const [database, sqs] = await Promise.all([
      check(() => this.orm.em.fork().execute('select 1')),
      check(() => this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.wager, AttributeNames: ['QueueArn'] }))),
    ]);
    const shuttingDown = this.shutdown.isShuttingDown;
    const ready = database === 'up' && sqs === 'up' && !shuttingDown;
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { database, sqs }, ...(shuttingDown ? { shuttingDown } : {}) };
  }
}
