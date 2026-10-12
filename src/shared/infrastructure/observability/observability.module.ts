import { Controller, Get, Global, Header, Inject, Module } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { createRootLogger, PinoNestLogger, ROOT_LOGGER } from './logger.ts';
import { METRICS, Metrics } from './metrics.ts';

/** `GET /metrics` no formato de exposição do Prometheus (aberto, como os health checks). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: ROOT_LOGGER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createRootLogger(config.logLevel) },
    { provide: PinoNestLogger, inject: [ROOT_LOGGER], useFactory: (root: PinoLogger) => new PinoNestLogger(root) },
    // A fonte do outbox lag é registrada pelo MessagingModule (dono da tabela outbox_messages).
    { provide: METRICS, useFactory: () => new Metrics() },
  ],
  exports: [ROOT_LOGGER, PinoNestLogger, METRICS],
})
export class ObservabilityModule {}
