import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export type Source = 'http' | 'sqs' | 'worker';

/** Fonte do outbox lag: consultada a cada scrape (idade do evento pendente mais antigo). */
export interface OutboxBacklogProbe {
  backlog(): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

/**
 * Métricas do §12, padrão Prometheus (`_total`, `_seconds`). Labels de baixa cardinalidade:
 * nunca ids de wallet, transação ou provedor. As métricas padrão de processo ficam de fora:
 * sob Bun, `eventLoopUtilization()` sempre retorna zero (issue oven-sh/bun#34068).
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações de aposta tratadas, por status final, kind e entrada.',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicatas detectadas: replays idempotentes, conflitos de idempotency key e messageIds reutilizados.',
    labelNames: ['kind', 'source'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas agendadas (SQS com backoff, outbox reagendada, referência reagendada).',
    labelNames: ['component', 'reason'] as const,
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ, por motivo.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Locks de wallet não obtidos a tempo (lock_timeout) ou deadlocks detectados pelo banco.',
    labelNames: ['sqlstate'] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência do processamento de uma transação de aposta (do recebimento ao commit).',
    labelNames: ['source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos de integração publicados no broker.',
    registers: [this.registry],
  });

  readonly pendingReferenceOutcomes = new Counter({
    name: 'wagering_pending_reference_outcomes_total',
    help: 'Resultados do reprocessamento de referências fora de ordem.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Reconciliações em que o saldo materializado diverge do ledger (nunca corrigidas automaticamente).',
    registers: [this.registry],
  });

  readonly schemaGuardViolations = new Counter({
    name: 'wagering_schema_guard_violations_total',
    help: 'Escritas barradas por constraint/trigger do banco que a aplicação deveria ter evitado (bug).',
    registers: [this.registry],
  });

  readonly httpRequests = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'Duração das requisições HTTP por rota e status.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private backlogProbe: OutboxBacklogProbe | undefined;
  private backlogRefresh: Promise<void> | undefined;

  /**
   * O registry serializa todas as métricas em paralelo (`Promise.all`), chamando o `collect` de
   * cada uma antes de lê-la. Os dois gauges aguardam a mesma consulta em andamento: assim os dois
   * saem do mesmo scrape, nunca com o valor do scrape anterior, e o banco é consultado uma vez.
   */
  readonly outboxLag: Gauge = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo da outbox (0 quando não há pendências).',
    registers: [this.registry],
    collect: () => this.refreshBacklog(),
  });

  readonly outboxPending: Gauge = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Eventos na outbox ainda não publicados.',
    registers: [this.registry],
    collect: () => this.refreshBacklog(),
  });

  useOutboxBacklogProbe(probe: OutboxBacklogProbe): void {
    this.backlogProbe = probe;
  }

  private refreshBacklog(): Promise<void> {
    const probe = this.backlogProbe;
    if (probe === undefined) return Promise.resolve();
    this.backlogRefresh ??= (async () => {
      try {
        const { pending, oldestAgeSeconds } = await probe.backlog();
        this.outboxLag.set(oldestAgeSeconds);
        this.outboxPending.set(pending);
      } catch {
        // banco indisponível: mantém o último valor; a readiness reporta a falha
      } finally {
        this.backlogRefresh = undefined;
      }
    })();
    return this.backlogRefresh;
  }

  /** Cronômetro em segundos para histogramas. */
  static startTimer(): () => number {
    const started = performance.now();
    return () => (performance.now() - started) / 1000;
  }
}

export const METRICS = Symbol('Metrics');
