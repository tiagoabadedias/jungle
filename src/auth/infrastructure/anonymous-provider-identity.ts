import type { ProviderIdentity, ProviderIdentityPort } from '../application/ports/provider-identity.port.ts';

/** Implementação no-op: aceita qualquer chamador. Substituível por um adapter OIDC sem tocar nos controllers. */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
