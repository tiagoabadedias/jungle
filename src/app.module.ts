import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.ts';
import { HealthController, ShutdownState } from './health/health.controller.ts';
import { ShutdownLogger } from './health/shutdown-logger.ts';
import { MessagingModule } from './messaging/messaging.module.ts';
import { DatabaseModule } from './shared/infrastructure/database/database.module.ts';
import { RequestContextMiddleware } from './shared/infrastructure/http/correlation-id.ts';
import { ObservabilityModule } from './shared/infrastructure/observability/observability.module.ts';
import { SharedModule } from './shared/infrastructure/shared.module.ts';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module.ts';
import { WageringModule } from './wagering/wagering.module.ts';
import { WalletModule } from './wallet/wallet.module.ts';

@Module({
  imports: [SharedModule, DatabaseModule, ObservabilityModule, SqsModule, AuthModule, WalletModule, WageringModule, MessagingModule],
  controllers: [HealthController],
  providers: [ShutdownLogger, ShutdownState],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
