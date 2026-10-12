import type { Clock } from '../application/ports/clock.ts';
import type { IdGenerator } from '../application/ports/id-generator.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUID v7: ordenável por tempo, bom para índices B-tree e para o cursor do ledger. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
