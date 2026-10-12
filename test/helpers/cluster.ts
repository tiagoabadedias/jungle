import type { Subprocess } from 'bun';

/**
 * Instâncias reais da aplicação (`bun src/main.ts`) em processos separados, contra o mesmo
 * PostgreSQL e as mesmas filas: o cenário de "múltiplas instâncias" do §8/§13 sem atalhos.
 */
export interface InstanceOptions {
  /** Variáveis específicas desta instância (filas, workers, FAULT_INJECTION…). */
  env?: Record<string, string>;
}

export class AppInstance {
  private readonly tail: string[] = [];
  private readonly drained: Promise<void>;

  private constructor(
    readonly name: string,
    readonly port: number,
    readonly process: Subprocess<'ignore', 'pipe', 'pipe'>,
  ) {
    // Drena stdout/stderr continuamente: um pipe cheio (64 KB) bloquearia o processo filho.
    this.drained = Promise.all([this.pump(process.stdout), this.pump(process.stderr)]).then(() => undefined);
  }

  static async start(name: string, options: InstanceOptions = {}): Promise<AppInstance> {
    const port = await freePort();
    const child = Bun.spawn(['bun', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        LOG_LEVEL: 'warn',
        DATABASE_POOL_MAX: '5',
        ...options.env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const instance = new AppInstance(name, port, child);
    await instance.waitReady();
    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get exitCode(): number | null {
    return this.process.exitCode;
  }

  get signalCode(): string | null {
    return this.process.signalCode;
  }

  /** Últimas linhas de saída (diagnóstico quando um teste falha). */
  logs(): string {
    return this.tail.join('\n');
  }

  async exited(): Promise<number> {
    const code = await this.process.exited;
    await this.drained;
    return code;
  }

  /** SIGTERM: encerramento gracioso. SIGKILL: queda abrupta (crash). */
  async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<number> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill(signal);
    return this.exited();
  }

  async metrics(): Promise<string> {
    return (await fetch(`${this.baseUrl}/metrics`)).text();
  }

  private async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) {
        throw new Error(`instance ${this.name} exited during boot (code ${this.process.exitCode}):\n${this.logs()}`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health/ready`);
        if (response.ok) return;
      } catch {
        // ainda subindo
      }
      await Bun.sleep(100);
    }
    throw new Error(`instance ${this.name} did not become ready:\n${this.logs()}`);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      for (const line of decoder.decode(chunk, { stream: true }).split('\n')) {
        if (line.length === 0) continue;
        this.tail.push(line);
        if (this.tail.length > 200) this.tail.shift();
      }
    }
  }
}

/** Grupo de instâncias com limpeza garantida (nenhum processo órfão após o teste). */
export class Cluster {
  readonly instances: AppInstance[] = [];

  async start(count: number, options: InstanceOptions = {}, prefix = 'app'): Promise<AppInstance[]> {
    const started = await Promise.all(
      Array.from({ length: count }, (_, i) => AppInstance.start(`${prefix}-${this.instances.length + i + 1}`, options)),
    );
    this.instances.push(...started);
    return started;
  }

  async add(name: string, options: InstanceOptions = {}): Promise<AppInstance> {
    const instance = await AppInstance.start(name, options);
    this.instances.push(instance);
    return instance;
  }

  async stopAll(signal: 'SIGTERM' | 'SIGKILL' = 'SIGKILL'): Promise<void> {
    await Promise.all(this.instances.map((instance) => instance.stop(signal)));
  }
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

/** Variáveis para uma instância consumir/publicar nas filas exclusivas do teste. */
export function messagingEnv(queues: { wager: string; dlq: string; events: string }, overrides: Record<string, string> = {}) {
  return {
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    SQS_WAGER_QUEUE: queues.wager,
    SQS_WAGER_DLQ: queues.dlq,
    SQS_EVENTS_QUEUE: queues.events,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_DELAY_MS: '1000',
    SQS_RETRY_MAX_DELAY_MS: '3000',
    SQS_DRAIN_TIMEOUT_MS: '5000',
    OUTBOX_POLL_INTERVAL_MS: '200',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
    REFERENCE_RETRY_BASE_DELAY_MS: '200',
    REFERENCE_RETRY_MAX_DELAY_MS: '1000',
    ...overrides,
  };
}
