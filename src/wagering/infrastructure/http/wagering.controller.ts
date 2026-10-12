import { Body, Controller, Get, Inject, Logger, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../../../auth/infrastructure/http/provider-auth.guard.ts';
import { FAILURE_CODES } from '../../../shared/domain/failure-code.ts';
import { CorrelationId } from '../../../shared/infrastructure/http/correlation-id.ts';
import { assignLogContext } from '../../../shared/infrastructure/observability/log-context.ts';
import { METRICS, Metrics } from '../../../shared/infrastructure/observability/metrics.ts';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case.ts';
import {
  GetWagerTransactionUseCase,
  type WagerTransactionResultView,
  type WagerTransactionView,
} from '../../application/wager-transaction-views.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.ts';
import { logWagerHandled, recordWagerFailure, recordWagerResult } from '../observability/wager-telemetry.ts';
import { toProcessCommand } from '../wager-submission.ts';
import { IdempotencyKey, SubmitWagerTransactionDto } from './wagering.dto.ts';

interface StatusWritableResponse {
  status(code: number): unknown;
}

type SubmitResponse = WagerTransactionResultView & { retryable?: boolean };

/**
 * Status HTTP pelo resultado (§9), igual na primeira resposta e no replay:
 * 201 aplicada · 202 aguardando referência · 422 rejeitada por regra de negócio · 500 FAILED.
 */
export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

@Controller('wagering/transactions')
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger = new Logger('Wagering');

  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Post()
  async submit(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: SubmitWagerTransactionDto,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusWritableResponse,
  ): Promise<SubmitResponse> {
    assignLogContext({ providerId: body.providerId, walletId: body.walletId });
    const elapsed = Metrics.startTimer();
    const command = toProcessCommand(body, idempotencyKey, { correlationId, causationId: idempotencyKey });
    const result = await this.processTransaction.execute(command).catch((error: unknown) => {
      recordWagerFailure(this.metrics, 'http', error, elapsed());
      throw error;
    });
    recordWagerResult(this.metrics, 'http', body.kind, result, elapsed());
    logWagerHandled(this.logger, body.kind, result);
    response.status(httpStatusFor(result.status));
    return result.failureCode === undefined ? result : { ...result, retryable: FAILURE_CODES[result.failureCode].retryable };
  }

  @Get(':transactionId')
  get(@Param('transactionId', ParseUUIDPipe) transactionId: string): Promise<WagerTransactionView> {
    return this.getTransaction.byId(transactionId);
  }
}

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(ProviderAuthGuard)
export class ProviderTransactionsController {
  constructor(@Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getTransaction.byProviderExternalId(providerId, externalTransactionId);
  }
}
