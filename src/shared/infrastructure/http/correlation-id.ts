import { createParamDecorator, type ExecutionContext, Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type LogContext, runWithLogContext } from '../observability/log-context.ts';
import { METRICS, Metrics } from '../observability/metrics.ts';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

interface ContextualRequest {
  method: string;
  originalUrl?: string;
  url: string;
  baseUrl?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface ObservableResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * Abre o contexto de log da requisição (correlationId recebido ou gerado, devolvido no
 * header), registra a latência por rota e um access log estruturado ao final.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware<ContextualRequest, ObservableResponse> {
  private readonly logger = new Logger('Http');

  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  use(request: ContextualRequest, response: ObservableResponse, next: () => void): void {
    const received = request.headers[CORRELATION_HEADER];
    const candidate = Array.isArray(received) ? received[0] : received;
    const correlationId = candidate !== undefined && VALID_CORRELATION_ID.test(candidate) ? candidate : randomUUID();
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);

    const scope: LogContext = { correlationId };
    const elapsed = Metrics.startTimer();
    response.on('finish', () => {
      const seconds = elapsed();
      const route = request.route?.path === undefined ? 'unmatched' : `${request.baseUrl ?? ''}${request.route.path}`;
      this.metrics.httpRequests.observe({ method: request.method, route, status: String(response.statusCode) }, seconds);
      if (QUIET_ROUTES.has(route)) return;
      runWithLogContext(scope, () =>
        this.logger.log({
          msg: 'http request completed',
          method: request.method,
          route,
          status: response.statusCode,
          durationMs: (seconds * 1000) | 0,
        }),
      );
    });
    runWithLogContext(scope, next);
  }
}

export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<ContextualRequest>();
  return request.correlationId ?? randomUUID();
});
