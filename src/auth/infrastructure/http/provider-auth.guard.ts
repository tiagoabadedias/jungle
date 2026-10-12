import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../../application/ports/provider-identity.port.ts';

/**
 * Guard aplicado aos endpoints de wallet e wagering (health e fila ficam fora, §2).
 * No-op por decisão de escopo: com um adapter OIDC, passaria a exigir identidade e a
 * conferir que o providerId autenticado é o mesmo do payload.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    await this.identity.identify(request.headers);
    return true;
  }
}
