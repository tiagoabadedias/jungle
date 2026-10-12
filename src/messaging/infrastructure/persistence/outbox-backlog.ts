import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxBacklogProbe } from '../../../shared/infrastructure/observability/metrics.ts';

/** Outbox lag (§12): quantos eventos pendentes e a idade do mais antigo, consultados a cada scrape. */
export class SqlOutboxBacklogProbe implements OutboxBacklogProbe {
  constructor(private readonly orm: MikroORM) {}

  async backlog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await this.orm.em.fork().execute<{ pending: number; age: number }[]>(
      `select count(*)::int as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as age
         from outbox_messages
        where published_at is null`,
    );
    return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.age ?? 0 };
  }
}
