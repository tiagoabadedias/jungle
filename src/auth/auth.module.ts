import { Global, Module } from '@nestjs/common';
import { ProviderAuthGuard } from './infrastructure/http/provider-auth.guard.ts';
import { PROVIDER_IDENTITY } from './application/ports/provider-identity.port.ts';
import { AnonymousProviderIdentity } from './infrastructure/anonymous-provider-identity.ts';

@Global()
@Module({
  providers: [{ provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity }, ProviderAuthGuard],
  exports: [PROVIDER_IDENTITY, ProviderAuthGuard],
})
export class AuthModule {}
