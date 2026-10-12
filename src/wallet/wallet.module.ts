import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared/application/ports/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared/application/ports/clock.ts';
import { ID_GENERATOR, type IdGenerator } from '../shared/application/ports/id-generator.ts';
import { CreateWalletUseCase } from './application/create-wallet.use-case.ts';
import { RECONCILIATION_MONITOR, type ReconciliationMonitor } from './application/ports/reconciliation-monitor.ts';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.ts';
import { GetWalletUseCase, ListLedgerUseCase } from './application/wallet-queries.use-case.ts';
import { WalletsController } from './infrastructure/http/wallets.controller.ts';
import { LoggingReconciliationMonitor } from './infrastructure/observability/logging-reconciliation-monitor.ts';

@Module({
  controllers: [WalletsController],
  providers: [
    { provide: RECONCILIATION_MONITOR, useClass: LoggingReconciliationMonitor },
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase(uow, clock, ids),
    },
    { provide: GetWalletUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow) },
    { provide: ListLedgerUseCase, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new ListLedgerUseCase(uow) },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, RECONCILIATION_MONITOR],
      useFactory: (uow: UnitOfWork, monitor: ReconciliationMonitor) => new ReconcileWalletUseCase(uow, monitor),
    },
  ],
})
export class WalletModule {}
