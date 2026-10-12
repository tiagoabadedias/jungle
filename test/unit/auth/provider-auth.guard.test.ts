import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import type { ProviderIdentity, ProviderIdentityPort } from '../../../src/auth/application/ports/provider-identity.port.ts';
import { ProviderAuthGuard } from '../../../src/auth/infrastructure/http/provider-auth.guard.ts';

type Headers = Readonly<Record<string, string | string[] | undefined>>;

class RecordingIdentity implements ProviderIdentityPort {
  readonly calls: Headers[] = [];

  async identify(headers: Headers): Promise<ProviderIdentity | undefined> {
    this.calls.push(headers);
    return undefined;
  }
}

function httpContext(headers: Headers): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext;
}

describe('ProviderAuthGuard (§2: sem autenticação, ponto de extensão)', () => {
  test('repassa os headers da requisição para a porta de identidade e libera o acesso', async () => {
    const identity = new RecordingIdentity();
    const headers = { authorization: 'Bearer token', 'idempotency-key': 'k-1' };

    const allowed = await new ProviderAuthGuard(identity).canActivate(httpContext(headers));

    expect(allowed).toBe(true);
    expect(identity.calls).toEqual([headers]);
  });
});
