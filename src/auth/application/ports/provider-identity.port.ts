/**
 * Ponto de extensão de autenticação (§2). Autenticação não está implementada neste desafio
 * (decisão documentada no ARCHITECTURE.md). O desenho previsto: um IdP externo (Keycloak/OIDC)
 * emite tokens client-credentials por provedor; um adapter desta porta valida o JWT (JWKS) e
 * devolve o providerId autorizado, que o guard compara com o `providerId` do payload.
 */
export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /** Resolve a identidade do chamador a partir das credenciais da requisição; undefined = anônimo. */
  identify(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');
