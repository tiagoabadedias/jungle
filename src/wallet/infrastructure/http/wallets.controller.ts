import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../../../auth/infrastructure/http/provider-auth.guard.ts';
import { CorrelationId } from '../../../shared/infrastructure/http/correlation-id.ts';
import { CreateWalletUseCase, type WalletView } from '../../application/create-wallet.use-case.ts';
import type { ReconciliationReport } from '../../application/ports/reconciliation-monitor.ts';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case.ts';
import {
  GetWalletUseCase,
  LEDGER_PAGE_DEFAULT,
  type LedgerEntryView,
  ListLedgerUseCase,
} from '../../application/wallet-queries.use-case.ts';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.ts';
import { CreateWalletDto, LedgerQueryDto } from './wallet.dto.ts';

interface LedgerResponse {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

/** Controllers só traduzem HTTP ↔ use case; nenhuma regra de negócio aqui. */
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListLedgerUseCase) private readonly listLedger: ListLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateWalletDto, @CorrelationId() correlationId: string): Promise<WalletView> {
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: { amount: body.initialBalance.amount, currency: body.initialBalance.currency },
      context: { correlationId },
    });
  }

  @Get(':walletId')
  get(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId', ParseUUIDPipe) walletId: string, @Query() query: LedgerQueryDto): Promise<LedgerResponse> {
    const after = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);
    const page = await this.listLedger.execute(walletId, after, query.limit ?? LEDGER_PAGE_DEFAULT);
    return {
      walletId: page.walletId,
      entries: page.entries,
      nextCursor: page.next === undefined ? null : encodeLedgerCursor(page.next),
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
