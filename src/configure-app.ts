import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './shared/infrastructure/http/http-error.filter.ts';
import { PinoNestLogger } from './shared/infrastructure/observability/logger.ts';
import { METRICS, type Metrics } from './shared/infrastructure/observability/metrics.ts';

/** Configuração HTTP compartilhada entre `main.ts` e os testes (mesmo comportamento nos dois). */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(PinoNestLogger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Sem conversão implícita: "25.00" continua string; nada vira number por acidente.
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter(app.get<Metrics>(METRICS)));
  app.enableShutdownHooks();
  return app;
}
