# Bun 1.x + TypeScript strict: guia de boas práticas

> Escopo: NestJS + MikroORM + PostgreSQL + SQS rodando em **Bun 1.x** (runtime, package manager e test runner), TypeScript `strict`.
> Pesquisado em 2026-10-10 na documentação oficial (bun.sh / bun.com, typescriptlang.org) e nas issues do GitHub `oven-sh/bun`.
> Legenda: **⚠ RISCO** = incompatibilidade ou armadilha conhecida · **✅** = recomendação.

---

## 0. Resumo dos riscos (TL;DR)

| # | Risco | Mitigação |
|---|---|---|
| R1 | Com `emitDecoratorMetadata`, um tipo ou interface importado **sem** `import type` quebra o link do módulo (`Export named 'X' not found`). Issues [#6172](https://github.com/oven-sh/bun/issues/6172), [#8439](https://github.com/oven-sh/bun/issues/8439), [#15006](https://github.com/oven-sh/bun/issues/15006). | `verbatimModuleSyntax: true` + `bun check` no CI (o compilador acusa TS1484/TS1272). |
| R2 | `emitDecoratorMetadata` + import circular → `Cannot access uninitialized variable` (TDZ). [#7591](https://github.com/oven-sh/bun/issues/7591), [#7444](https://github.com/oven-sh/bun/issues/7444). | Entidades MikroORM via `EntitySchema` (sem decorators), como já define o PLAN. No Nest, usar `forwardRef()` e evitar ciclos. |
| R3 | Em `strict`, o Bun serializa `X \| undefined` / `X \| null` como `X` no `design:paramtypes`, enquanto o `tsc` usa `Object`. [#44120](https://github.com/oven-sh/bun/issues/44120) (aberta, correção em andamento). | Não tipar parâmetros injetados como união. Usar `@Optional()` + `@Inject(TOKEN)` explícito. |
| R4 | `tsconfig` com `extends` apontando para **pacote** (`"@org/tsconfig"`) é ignorado pelo transpilador: decorators viram TC39 e **nenhuma metadata é emitida**. [#6326](https://github.com/oven-sh/bun/issues/6326), [#34494](https://github.com/oven-sh/bun/issues/34494). | Flags de decorator inline no `tsconfig.json` da raiz (ou `extends` relativo). |
| R5 | `bun build --compile --production/--bytecode/--minify` quebra o `Reflector` do Nest (`Nest can't resolve dependencies…`). [#9838](https://github.com/oven-sh/bun/issues/9838) | Não empacotar nem minificar o Nest. Rodar TS direto: `bun src/main.ts`. |
| R6 | CLIs com shebang `node` (MikroORM CLI, Nest CLI) rodam no **Node** se ele estiver no PATH. [mikro-orm#7035](https://github.com/mikro-orm/mikro-orm/issues/7035), [nest#16660](https://github.com/nestjs/nest/issues/16660) | `bunx --bun mikro-orm …` (ou `[run] bun = true`). Não usar `nest start`. |
| R7 | O threshold de coverage só é verificado quando o reporter `text` está ativo. Com **apenas** `lcov`, o processo sai com 0. A chave `statements` não é aplicada. | `coverageReporter = ["text", "lcov"]`. |
| R8 | `bun test` roda **todos os arquivos no mesmo processo e no mesmo global** por padrão: estado, mocks e `mock.module()` vazam entre arquivos. | Integração serial e isolada. Unitários com `--parallel` (que implica `--isolate`). |
| R9 | `expect(asyncFn).toThrow()` em código que consulta o PostgreSQL pode travar sem disparar o timeout. [#19130](https://github.com/oven-sh/bun/issues/19130) | Sempre `await expect(promise).rejects.toThrow()`. |
| R10 | Subprocessos do `Bun.spawn` **não** são mortos automaticamente quando o pai sai. | `proc.kill()` + `await proc.exited` no `afterAll`. |
| R11 | Bun 1.4.2 trava (100% de CPU, sem log) em CPUs sem AVX/SSE4.2, como VMs QEMU/KVM de CI. [#43683](https://github.com/oven-sh/bun/issues/43683) | Fixar a versão. Em runner exótico, testar ou usar 1.4.1. |
| R12 | Handlers de `SIGTERM` não disparam se houver listener `data` ativo em `process.stdin`. [#30189](https://github.com/oven-sh/bun/issues/30189) | Não ler stdin na app. |

---

## 1. Versão e instalação (macOS, sem sudo)

- **Versão estável atual: Bun v1.4.2** (05/set/2026, marcada "Latest"). As anteriores são 1.4.1, 1.4.0 e 1.3.14. Não existe Bun 2.0. Fontes: [GitHub Releases](https://github.com/oven-sh/bun/releases) e [bun.sh/docs/installation](https://bun.sh/docs/installation).
- ✅ Instalação **sem sudo**. O script instala em `~/.bun/bin`:

```bash
curl -fsSL https://bun.com/install | bash                 # última estável
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"  # versão fixa (recomendado p/ reprodutibilidade)
# se der "command not found", adicione ao ~/.zshrc:
export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
bun --version
```

- Alternativa: `brew install oven-sh/bun/bun`. Nesse caso, atualize com `brew upgrade bun` e não com `bun upgrade`.
- ✅ Fixe a versão em todos os lugares: `"packageManager": "bun@1.4.2"` no `package.json`, `oven/bun:1.4.2-*` no Docker e `bun-version` no CI.
- Atualizar: `bun upgrade`. Para voltar do canary: `bun upgrade --stable`.

---

## 2. `bun test`

Docs: [cli/test](https://bun.sh/docs/cli/test) · [writing](https://bun.sh/docs/test/writing) · [lifecycle](https://bun.sh/docs/test/lifecycle) · [discovery](https://bun.sh/docs/test/discovery) · [parallel](https://bun.sh/docs/test/parallel) · [runtime-behavior](https://bun.sh/docs/test/runtime-behavior) · [mocks](https://bun.sh/docs/test/mocks) · [coverage](https://bun.sh/docs/test/coverage)

### 2.1 Estrutura e API

- Arquivos descobertos: `*.test.*`, `*_test.*`, `*.spec.*` e `*_spec.*` (ts/tsx/js/…). `node_modules` e diretórios ocultos ficam de fora.
- Tudo vem de `bun:test`, com API compatível com Jest:

```ts
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test";

describe("Money", () => {
  test("soma exata", () => {
    expect(Money.from("0.10", "BRL").add(Money.from("0.20", "BRL")).toString()).toBe("0.30");
  });
  test.each([["1e3"], ["NaN"], [""]])("rejeita %p", (raw) => {
    expect(() => Money.from(raw, "BRL")).toThrow();
  });
});
```

- Modificadores disponíveis: `test.skip`, `test.todo`, `test.only` (precisa de `--only`), `test.if(cond)`, `test.skipIf`, `test.failing`, `test.each` e `describe.each`. Também há `expect.assertions(n)` e `expect.hasAssertions()`.
- Opções por teste: `{ retry: N }` ou `{ repeats: N }`, nunca as duas juntas.
- **⚠ R9:** para código assíncrono, use `await expect(promise).rejects.toThrow()`. Não use `expect(async () => …).toThrow()`, que pode travar com o PostgreSQL ([#19130](https://github.com/oven-sh/bun/issues/19130)).

### 2.2 Hooks

- `beforeAll`, `beforeEach`, `afterEach`, `afterAll` e `onTestFinished`. Todos aceitam `async`.
- O escopo depende de onde o hook está: dentro de um `describe`, no topo do arquivo, ou num **preload** (global, roda em todos os arquivos).
- Se um `beforeAll` lançar erro, todos os testes daquele escopo são **pulados**. Faça log e relance o erro para o motivo aparecer.
- `onTestFinished` não funciona em testes concorrentes.
- A documentação **não define timeout para hooks**. Não conte com um. Coloque timeouts explícitos nas esperas de infra (healthcheck, fila).

### 2.3 Timeouts

- O padrão é **5000 ms** por teste. Para mudar globalmente: `bun test --timeout 30000`. Por teste: `test("x", fn, 30_000)` ou `jest.setTimeout()`. O valor `0` ou `Infinity` desativa o timeout.
- Quando um teste estoura o timeout, o Bun **mata os subprocessos criados por ele** ([writing](https://bun.sh/docs/test/writing)).
- ✅ Testes de integração e concorrência (Docker, SQS, 3 instâncias) precisam de timeouts de 30 a 120 s, definidos no script ou no próprio teste.

### 2.4 `--preload`

- `bun test --preload ./test/setup.ts` ou `[test] preload = [...]` no `bunfig.toml`.
- ✅ No preload: `import "reflect-metadata"` (obrigatório para o Nest DI nos testes), validação de env e hooks globais.
- Com `--isolate`/`--parallel`, o preload **roda de novo em cada arquivo**. Sem isolamento, roda uma vez.
- ⚠ `bun check` / `--check` **não verifica tipos dos arquivos de preload**, a menos que o `tsconfig` os inclua.

### 2.5 Filtros

```bash
bun test test/unit            # filtro por SUBSTRING de caminho (não é glob!)
bun test ./test/unit/money.test.ts   # caminho exato: prefixe ./ ou /
bun test -t "Wallet debit"    # regex sobre o nome completo (describe + test)
```

- ⚠ O filtro posicional é **substring**. `bun test unit` também pega `src/foo/community.test.ts`. Use prefixos de diretório que não sejam ambíguos (`test/unit/`).
- Para excluir arquivos: `pathIgnorePatterns` no bunfig ou `--path-ignore-patterns`. A flag de CLI **substitui** a configuração do bunfig, não soma.

### 2.6 Execução entre arquivos: serial, paralela ou isolada (IMPORTANTE para o DB)

| Modo | Arquivos | Global/módulos | Uso no projeto |
|---|---|---|---|
| `bun test` (padrão) | **serial, 1 processo** | **compartilhados** entre arquivos | ✅ integração e concorrência (DB e fila compartilhados) |
| `--isolate` | serial | novo `globalThis` e registry por arquivo; fecha servers e subprocessos | ✅ integração, se houver vazamento de estado |
| `--parallel[=N]` | N workers (padrão = nº de CPUs) | implica `--isolate` | ✅ unitários (domínio puro) |
| `--parallel --no-isolate` | N workers | 1 global por worker | só se os arquivos não vazarem estado |
| `--concurrent` / `test.concurrent` | — | testes **do mesmo arquivo** se intercalam no mesmo thread | cooperativo, sem CPU extra |

- `--parallel` está na doc da 1.4. A página não informa a versão de introdução, mas o output de exemplo mostra `v1.4.0`. Cada worker recebe `BUN_TEST_WORKER_ID` / `JEST_WORKER_ID` (base 1). Coverage e JUnit são mesclados pelo coordenador.
- ⚠ **R8:** no modo padrão, mocks, singletons e conexões de um arquivo **vazam** para o próximo. Feche o `MikroORM` e a app Nest no `afterAll` de cada arquivo.
- ✅ Recomendação para o projeto:
  - `test/unit` → `bun test test/unit/ --parallel`
  - `test/integration` e `test/concurrency` → `bun test test/integration/ test/concurrency/ --timeout 60000`, **sem `--parallel`**. Os arquivos ficam em série, cada um com IDs novos (já é a estratégia do PLAN §9).
  - Se um dia quiser paralelizar a integração: um banco ou schema por worker, `app_test_${process.env.BUN_TEST_WORKER_ID}` ([parallel](https://bun.sh/docs/test/parallel)).
- ⚠ `test.concurrent` **não é paralelismo real**: as promessas se intercalam num único thread. A corrida no banco acontece de verdade, porque o servidor e o pool atendem as requisições ao mesmo tempo. Ainda assim, para o requisito "≥ 3 instâncias" (§13), use **processos** (`Bun.spawn`, seção 6).
- `--randomize` / `--seed N` ajudam a achar dependência de ordem. `--retry` mascara flakiness: **não use** em testes de concorrência.
- Variáveis de ambiente: `bun test` define `NODE_ENV=test` se ainda não estiver definido, e `TZ=Etc/UTC`. Ele carrega `.env.test` e **ignora** `.env.local` ([runtime-behavior](https://bun.sh/docs/test/runtime-behavior), [env](https://bun.sh/docs/runtime/env)).
- Erro não tratado **entre testes** (unhandled rejection) faz o processo sair com código ≠ 0, mesmo que todos os testes passem. Isso é bom: falhas assíncronas de workers aparecem.

### 2.7 Coverage

```bash
bun test --coverage                                   # text
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
```

- Métricas: **% Funcs** e **% Lines**. A chave `statements` é aceita mas **não é aplicada**.
- O threshold faz o processo sair com código ≠ 0. **⚠ R7:** fora de `--parallel`, a verificação só roda com o reporter `text` ativo.
- ⚠ A documentação se contradiz sobre o default de `coverageSkipTestFiles` (`false` em [bunfig](https://bun.sh/docs/runtime/bunfig), `true` em [coverage](https://bun.sh/docs/test/coverage)). **Defina explicitamente.**
- ⚠ A documentação não traz equivalente ao `collectCoverageFrom` do Jest. O relatório é montado a partir dos arquivos carregados na execução, então **confirme no spike** se um arquivo `src/` nunca importado aparece com 0%. Se não aparecer, o threshold de 80% fica inflado.

### 2.8 Mocks

```ts
const publish = mock(async (_e: IntegrationEvent) => {});   // == jest.fn()
const spy = spyOn(clock, "now").mockReturnValue(new Date("2026-01-01T00:00:00Z"));
afterEach(() => { mock.restore(); mock.clearAllMocks(); });
```

- `mockClear` limpa o histórico. `mockReset` também remove a implementação. `mockRestore` / `mock.restore()` restaura os originais dos spies.
- `mock.module(spec, factory)` substitui módulos ESM/CJS, inclusive depois do import (os live bindings são atualizados).
  - ⚠ `mock.restore()` **não desfaz** `mock.module()`. O mock persiste e, no modo padrão, **vaza para os arquivos seguintes**.
  - ⚠ Mockar depois do import não impede os side effects do módulo original. Para impedir, use o preload.
  - Não existe `__mocks__` nem automock.
- ✅ O §13 do desafio proíbe substituir PostgreSQL e SQS por mocks. Use mocks só para portas de domínio (Clock, IdGenerator) nos testes unitários, e prefira **injeção pelas portas** a `mock.module`.

---

## 3. `bunfig.toml`

Docs: [runtime/bunfig](https://bun.sh/docs/runtime/bunfig) · [test/configuration](https://bun.sh/docs/test/configuration)

```toml
# bunfig.toml
telemetry = false

[install]
exact = true                 # versões exatas no package.json
# frozenLockfile = true      # alternativa: usar `bun ci` no CI/Docker
minimumReleaseAge = 259200   # 3 dias: proteção contra pacote malicioso recém-publicado

[run]
bun = true                   # scripts/CLIs com shebang node rodam no Bun (R6)

[test]
root = "."                   # só aceita UM diretório
preload = ["./test/setup.ts"]
pathIgnorePatterns = ["dist/**", "docker/**"]
coverage = false             # ligado só no script test:cov
coverageReporter = ["text", "lcov"]   # "text" é obrigatório p/ o threshold valer (R7)
coverageDir = "coverage"
coverageThreshold = { lines = 0.8, functions = 0.8 }
coverageSkipTestFiles = true # explícito: os docs se contradizem quanto ao default
coveragePathIgnorePatterns = ["test/**", "migrations/**", "src/main.ts"]
```

- Outras chaves de `[test]`: `smol`, `randomize`, `seed`, `retry`, `rerunEach`, `concurrentTestGlob`, `onlyFailures` e `[test.reporter] junit = "path"`.
- ⚠ As páginas consultadas **não documentam** chaves `timeout`, `parallel` ou `isolate` no bunfig. Passe essas opções como **flags** nos scripts.
- `env = false` desliga o carregamento automático de `.env`. Arquivos passados com `--env-file` continuam sendo carregados.

---

## 4. Decorators no Bun (NestJS DI e MikroORM)

Fontes: [Bun v1.0.3 blog](https://bun.sh/blog/bun-v1.0.3) · [TS Handbook: Decorators](https://www.typescriptlang.org/docs/handbook/decorators.html) · [tsconfig reference](https://www.typescriptlang.org/tsconfig/)

- **Sim, o Bun emite `design:type`/`design:paramtypes`/`design:returntype`** a partir da v1.0.3 ("you can use Nest.js with Bun, and it will work out of the box"). Ele lê `experimentalDecorators` e `emitDecoratorMetadata` do `tsconfig.json`.
- Sem `experimentalDecorators`, o Bun compila os decorators com a **semântica TC39**, e o Nest quebra.
- ✅ `import "reflect-metadata";` deve ser a **primeira linha** do `src/main.ts` **e** do preload dos testes. Sem isso, a metadata não é registrada. Na [#4677](https://github.com/oven-sh/bun/issues/4677), o tsyringe falha com `requires a reflect polyfill`. O Nest falha de outra forma, mas pela mesma causa.

### Limitações conhecidas (issues conhecidas, estado em out/2026)

| Issue | Sintoma | Mitigação |
|---|---|---|
| ⚠ [#6172](https://github.com/oven-sh/bun/issues/6172) (aberta) / [#8439](https://github.com/oven-sh/bun/issues/8439), [#15006](https://github.com/oven-sh/bun/issues/15006) (duplicatas da #6172) | `SyntaxError: Export/Import named 'X' not found` quando um **tipo ou interface** aparece numa assinatura decorada e foi importado como valor. O `tsc` emitiria `Object`; o Bun emite uma referência ao nome. | **`verbatimModuleSyntax: true`** obriga `import type` para tipos (erro **TS1484**). Com `isolatedModules`, o TS acusa **TS1272** ("A type referenced in a decorated signature must be imported with 'import type'…"). Os dois foram verificados com `tsc` 5.9. Rode `bun check` no CI. |
| ⚠ [#7591](https://github.com/oven-sh/bun/issues/7591) (aberta; [#7444](https://github.com/oven-sh/bun/issues/7444) é duplicata) | `ReferenceError: Cannot access uninitialized variable` quando o `design:type` referencia uma classe ainda em TDZ (import circular entre entidades). | O PLAN usa **`EntitySchema` sem decorators** para o MikroORM, o que evita o problema. Se algum dia usar decorators nas entidades, use `Rel<T>` e `() => Entity`. No Nest, `forwardRef()`. |
| ⚠ [#44120](https://github.com/oven-sh/bun/issues/44120) (aberta, PR #44183) | Em `strict`, `X \| undefined` vira `X` no `design:paramtypes`, divergindo do `tsc`, que emite `Object`. | Não declare dependência injetada como `Foo \| undefined`. Use `@Optional() @Inject(FOO) foo?: Foo` com token explícito. |
| ⚠ [#6326](https://github.com/oven-sh/bun/issues/6326) (aberta) / [#34494](https://github.com/oven-sh/bun/issues/34494) (duplicata da #5277) | `extends` para um tsconfig **de pacote** é ignorado, e a metadata some sem nenhum aviso. | Flags inline no `tsconfig.json` raiz. `extends` relativo funciona. |
| ⚠ [#9838](https://github.com/oven-sh/bun/issues/9838) (aberta) | `Reflector` ou guards falham com `bun build --compile --production/--bytecode`. | Não empacotar a app. Rodar `bun src/main.ts`. |
| ⚠ [mikro-orm#7381](https://github.com/mikro-orm/mikro-orm/issues/7381) (fechada, sem correção confirmada) | ES decorators + `TsMorphMetadataProvider` falham no Bun. | `EntitySchema` (sem decorators, sem ts-morph). |
| ⚠ [#13766](https://github.com/oven-sh/bun/issues/13766) (aberta) | Metadata do MikroORM incorreta com mixins sob Bun. | Não usar mixins em entidades. `EntitySchema` explícito. |

- ⚠ **Lint:** o autofix de `@typescript-eslint/consistent-type-imports` pode converter `import { FooService }` em `import type` quando a classe só aparece na assinatura do construtor. A metadata vira `Object` e o DI do Nest quebra sem erro de compilação. Use lint type-aware com `emitDecoratorMetadata` no tsconfig, que é o que a regra respeita ([typescript-eslint blog](https://typescript-eslint.io/blog/changes-to-consistent-type-imports-with-decorators)), ou desative o autofix.
- **Decisão para o projeto:** os decorators ficam **só na camada Nest** (controllers, providers, DTOs com class-validator). O domínio e a persistência não usam decorators, o que já está alinhado com o PLAN §1 e o §6.1 do desafio.
- ✅ **Spike da fase 0** (checklist): (a) DI por tipo de classe resolve sem `@Inject`; (b) um `Reflector` com metadata customizada funciona em guards; (c) `ValidationPipe` + class-validator rejeita um DTO inválido; (d) o mesmo vale dentro de `bun test`.

---

## 5. `tsconfig.json` recomendado (strict + Nest + Bun)

Base: o tsconfig sugerido pelo `bun init` ([runtime/typescript](https://bun.sh/docs/runtime/typescript)), mais as flags de decorator e o endurecimento abaixo. Referência das flags: [tsconfig](https://www.typescriptlang.org/tsconfig/).

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "types": ["bun"],                    // bun add -d @types/bun
    "noEmit": true,                      // Bun transpila; ninguém usa tsc p/ emitir
    "allowImportingTsExtensions": true,

    // Nest DI (obrigatório, inline — R4)
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,

    // Guard contra R1 (implica isolatedModules)
    "verbatimModuleSyntax": true,

    // Strict
    "strict": true,                      // inclui strictNullChecks, strictPropertyInitialization…
    "noUncheckedIndexedAccess": true,    // ✅ compatível; arr[0] vira T | undefined
    "noImplicitOverride": true,          // ✅
    "noFallthroughCasesInSwitch": true,  // ✅ útil p/ switch de kind/status
    "noImplicitReturns": true,
    "useUnknownInCatchVariables": true,  // já incluso em strict
    "exactOptionalPropertyTypes": false, // ⚠ ver nota
    "noPropertyAccessFromIndexSignature": false,
    "skipLibCheck": true
  },
  "include": ["src", "test", "migrations"]
}
```

| Flag | Compatível com Nest/MikroORM? | Nota |
|---|---|---|
| `strict` | ✅ | `strictPropertyInitialization` obriga `!` ou inicializador em DTOs (`amount!: string`). |
| `noUncheckedIndexedAccess` | ✅ | Recomendado pelo próprio Bun. Afeta `rows[0]`, `process.env`, `Record<>` e regex groups. |
| `verbatimModuleSyntax` | ✅ e **recomendado** | Força `import type` para tipos (TS1484), o que evita R1. Classes injetadas continuam como import de valor. |
| `exactOptionalPropertyTypes` | ⚠ **Tentativa, não garantido** | Falha quando um tipo de lib com `foo?: T` recebe `{ foo: undefined }`. É comum em opções do Nest, do MikroORM e do AWS SDK. Não verificamos as tipagens dessas libs sob a flag. Ligue no spike e só mantenha se compilar sem `as`/`any`. |
| `noPropertyAccessFromIndexSignature` | ⚠ opcional | Obriga `process.env["X"]`. Melhor tipar o env (seção 8) e deixar `false`. |
| `useDefineForClassFields` | ⚠ verificar | O default é `true` com `target` ESNext (semântica `define`). Isso é seguro com `EntitySchema` e DTOs com `!`, mas pode sobrescrever propriedades que um decorator instala no prototype. Confirme no spike. |
| `isolatedModules` | ✅ | Implícito por `verbatimModuleSyntax`. |

- **O Bun não faz checagem de tipos ao executar.** Ela é opt-in: `bun check` (checker próprio, alvo de paridade com o TS 7, não precisa do pacote `typescript`), `bun test --check` ou `bun --check src/main.ts` ([runtime/check](https://bun.sh/docs/runtime/check)).
- ⚠ Se houver um script chamado `check` no `package.json`, ele tem precedência sobre o `bun check`. Por isso o script deve se chamar **`typecheck`**.
- ⚠ O editor usa o TypeScript dele. Para alinhar: `bun add -d typescript@$(bun -p process.versions.typescript)`.

---

## 6. Subprocessos (`Bun.spawn`) e sinais

Docs: [runtime/child-process](https://bun.sh/docs/runtime/child-process) · [guides/process/os-signals](https://bun.sh/guides/process/os-signals)

### 6.1 Três instâncias da app num teste

```ts
const procs = [0, 1, 2].map((i) =>
  Bun.spawn(["bun", "src/main.ts"], {
    env: { ...process.env, PORT: String(4100 + i), INSTANCE_ID: `i${i}` },
    stdout: "pipe",           // ou "inherit" para debug
    stderr: "inherit",
    killSignal: "SIGKILL",    // usado por timeout/AbortSignal
    onExit(_p, code, signal) { /* registrar */ },
  }),
);
// aguarde /health/ready de cada instância com polling + deadline (não sleep fixo)

afterAll(async () => {
  for (const p of procs) p.kill("SIGTERM");
  await Promise.all(procs.map((p) => p.exited));   // Promise<number>
});
```

- API: `proc.kill(sig?)`, `proc.exited` (Promise do exit code), `proc.exitCode`, `proc.signalCode`, `proc.killed`, `proc.pid`, `await proc.stdout.text()`, `proc.unref()`. Opções: `timeout`, `signal` (AbortSignal) e `ipc`.
- ⚠ **R10:** o pai **espera** os filhos, a menos que você chame `unref()`, mas a documentação **não garante** que os filhos morrem quando o pai sai. Sempre faça `kill` + `await exited` no `afterAll`.
- O timeout do teste mata os filhos que o próprio teste criou. Isso ajuda, mas não substitui o cleanup explícito.
- ✅ Cenário "crash depois do commit e antes do ack": `p.kill("SIGKILL")` simula a morte abrupta (sem handlers). `p.kill("SIGTERM")` testa o shutdown gracioso. Confira `p.signalCode`.
- ⚠ Isto vem do comportamento geral de pipes do SO, não da doc do Bun: não use `stdout: "pipe"` sem consumir o stream, porque um buffer cheio pode bloquear o filho. Use `"inherit"`/`"ignore"` ou leia o stream continuamente.

### 6.2 `SIGTERM` na app

- O Bun implementa `process.on("SIGTERM" | "SIGINT", …)`, `beforeExit` e `exit` da API do Node.
- ⚠ `exit`/`beforeExit` **não são emitidos** se o processo morrer por um sinal **sem listener**. Para ter cleanup num sinal, registre o listener e chame `process.exit()` no final.
- ✅ No Nest: `app.enableShutdownHooks()` (usa `process.on`) e `OnApplicationShutdown` no consumer SQS: parar o polling, concluir o in-flight e fazer `ChangeMessageVisibility 0` no restante. Para não travar, defina um deadline menor que o `stop_grace_period` do Docker (10 s por padrão).
- ⚠ **R12:** um listener `data` ativo em `process.stdin` impede a entrega de `SIGTERM`/`SIGINT` ([#30189](https://github.com/oven-sh/bun/issues/30189)).
- ⚠ `bun --watch` envia `SIGTERM` no restart (`--watch-kill-signal`). Os handlers rodam também em dev.

---

## 7. SHA-256 e UUID v7

Docs: [runtime/hashing](https://bun.sh/docs/runtime/hashing) · [runtime/utils](https://bun.sh/docs/runtime/utils)

```ts
// Bun nativo
const hex = new Bun.CryptoHasher("sha256").update(canonicalJson).digest("hex");
// node:crypto (também suportado pelo Bun — mais portável)
import { createHash } from "node:crypto";
const hex2 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
```

- ✅ Para o `payloadHash` (PLAN §6), prefira `node:crypto` atrás de uma porta `Hasher`. Funciona igual em Bun e Node, sem acoplar o domínio ao runtime.
- ⚠ **Nenhuma das duas APIs canonicaliza JSON.** `JSON.stringify` preserva a ordem de inserção das chaves. Implemente a ordenação recursiva das chaves e a omissão de `undefined` antes de calcular o hash, e teste que `{a,b}` e `{b,a}` geram o mesmo hash.
- ⚠ `Bun.hash` é **não criptográfico** (Wyhash 64-bit). Não use para idempotência.
- `Bun.randomUUIDv7(encoding?: "hex"|"base64"|"base64url"|"buffer", timestamp?)`:
  - Gera timestamp de 48 bits + contador + bits aleatórios criptograficamente seguros.
  - É **estritamente crescente dentro do processo** (RFC 9562 §6.2), com contador atômico entre Workers.
  - ⚠ A monotonicidade vale **por processo**. Entre 3 instâncias, os IDs são únicos mas não totalmente ordenados. Para ordenação estável (cursor do ledger), use `(created_at, id)`, como já prevê o PLAN.
- ✅ Encapsule em `IdGenerator` (porta do domínio): `import { randomUUIDv7 } from "bun"` só na infra. Em teste, use um gerador determinístico.

---

## 8. Scripts, `bun run` e variáveis de ambiente

Docs: [cli/run](https://bun.sh/docs/cli/run) · [runtime/env](https://bun.sh/docs/runtime/env) · [cli/install](https://bun.sh/docs/cli/install) · [install/lifecycle](https://bun.sh/docs/install/lifecycle)

```jsonc
{
  "packageManager": "bun@1.4.2",
  "scripts": {
    "start": "bun src/main.ts",
    "dev": "bun --watch src/main.ts",
    "typecheck": "bun check",
    "test": "bun test test/unit/ --parallel && bun test test/integration/ test/concurrency/ --timeout 60000",
    "test:unit": "bun test test/unit/ --parallel",
    "test:integration": "bun test test/integration/ --timeout 60000",
    "test:concurrency": "bun test test/concurrency/ --timeout 120000",
    "test:cov": "bun test --coverage --timeout 120000",
    "test:load": "bun test/load/run.ts",
    "migration:up": "bunx --bun mikro-orm migration:up",
    "migration:down": "bunx --bun mikro-orm migration:down"
  }
}
```

- `test:cov` precisa ser **uma única execução** de todas as suítes. O coverage não é mesclado entre invocações de `bun test`, então use o timeout da suíte mais lenta.
- `bun run <script>` executa num subshell (bash/sh/zsh) e respeita `pre<script>`/`post<script>`. O atalho `bun <script>` perde para comandos built-in de mesmo nome, como `test`, `check` e `install`. Use `bun run test` se quiser o script e não o runner.
- ⚠ `bun --watch run dev` funciona. `bun run dev --watch` passa a flag para o script, não para o Bun.
- ⚠ **R6:** CLIs com shebang `#!/usr/bin/env node` rodam no Node. Use `bun run --bun <cli>`, `bunx --bun …` ou `[run] bun = true`.
- **`.env` automático** (do menor para o maior precedente): `.env` → `.env.{NODE_ENV}` → `.env.local` (não carregado em `test`) → `.env.{NODE_ENV}.local`.
  - Expansão `$VAR` é suportada. Escape com `\$`.
  - `--env-file=…` substitui os arquivos padrão. `--no-env-file` ou `env = false` desligam o carregamento.
  - `Bun.env` e `import.meta.env` são aliases de `process.env`.
- ✅ Tipagem: todo `process.env.X` é `string | undefined`. Valide **uma vez** no boot com um schema (falha rápida) e exporte um `Config` tipado. Evite o `declare module "bun" { interface Env { X: string } }`, que só mente para o compilador.
- ⚠ Nunca coloque `.env` com secrets na imagem. Ele deve estar no `.dockerignore`.
- **Install:** o lockfile é `bun.lock` (texto, deve ser commitado). Em CI e Docker use `bun ci` ou `bun install --frozen-lockfile`, que são equivalentes (o Dockerfile abaixo usa a forma longa).
  - `--production` exclui devDependencies (e implica `--frozen-lockfile`).
  - ⚠ O Bun **não executa lifecycle scripts de dependências** fora de uma allowlist padrão. Se algum pacote precisar de `postinstall`, adicione-o a `trustedDependencies`, lembrando que isso **substitui** a lista padrão.

---

## 9. Docker (`oven/bun`)

Docs: [guides/ecosystem/docker](https://bun.sh/guides/ecosystem/docker) · [tags no Docker Hub](https://hub.docker.com/r/oven/bun/tags)

- Tags disponíveis (verificadas): `1.4.2`, `1.4.2-slim`, `1.4.2-alpine`, `1.4.2-distroless`, `1.4.2-debian`, `1`, `1-slim`, `1-alpine`, `1-distroless`, `latest`, `canary*`.
- ✅ **Fixe a versão completa** (`1.4.2-slim`). O guia oficial usa `oven/bun:1`, que flutua.
- Usuário não-root: a imagem já traz o usuário **`bun`**, e o guia oficial usa `USER bun`.

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2-slim AS base
WORKDIR /usr/src/app

FROM base AS deps-dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS deps-prod
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM deps-dev AS check            # opcional: falha o build se tipos/unit quebrarem
COPY . .
RUN bun check && bun test test/unit/

FROM base AS release
ENV NODE_ENV=production
COPY --from=deps-prod --chown=bun:bun /usr/src/app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json bunfig.toml ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun migrations ./migrations
USER bun
EXPOSE 3000/tcp
ENTRYPOINT ["bun", "src/main.ts"]
```

- ⚠ **Sinais:** use `ENTRYPOINT` em **forma exec** chamando `bun src/main.ts` diretamente, para o Bun ser o PID 1 e receber o `SIGTERM` do `docker stop`.
  - `bun run start` passa por um subshell, e a documentação não diz se ele repassa sinais.
  - A forma shell (`ENTRYPOINT bun …`) também não repassa sinais.
  - Se precisar de reaping de zumbis, use `docker run --init` ou `init: true` no Compose.
- ⚠ O `tsconfig.json` **precisa ir para a imagem**: o Bun lê as flags de decorator dele em runtime (R4).
- ⚠ **R5:** não use `bun build --compile/--minify/--bytecode` com o Nest. Rode o TS direto.
- ⚠ `distroless` não tem shell: o `HEALTHCHECK` precisa ser um `bun -e "fetch(...)"`, e não dá para fazer debug com `sh`. A `slim` (Debian) é o meio-termo. Teste a `alpine` (musl) com o driver `pg` antes de adotá-la.
- ⚠ **R11:** Bun 1.4.2 em host x86 sem AVX/SSE4.2 (QEMU) trava silenciosamente ([#43683](https://github.com/oven-sh/bun/issues/43683)).
- Rodar migrations como passo separado no Compose: `command: ["bunx", "--bun", "mikro-orm", "migration:up"]` (precisa da CLI nas dependências de produção) ou um script TS com o `Migrator` programático.
- `.dockerignore` mínimo: `node_modules`, `.git`, `.env*`, `coverage`, `dist`, `*.log`, `docker-compose*.yml`.

---

## 10. Checklist da fase 0 (spike)

- [ ] `bun --version` = 1.4.2 local, no CI e no Docker. `packageManager` fixado.
- [ ] `tsconfig.json` com decorators inline + `verbatimModuleSyntax`. `bun check` limpo.
- [ ] Confirmar que `bun check` (alvo TS 6/7) aceita `experimentalDecorators`/`emitDecoratorMetadata` sem erro de opção e que **reporta TS1484/TS1272**. Isso foi verificado só com `tsc` 5.9. Se o `bun check` falhar, o fallback é `tsc --noEmit` com `typescript` fixado.
- [ ] `import "reflect-metadata"` primeiro em `main.ts` e em `test/setup.ts` (preload).
- [ ] Nest: DI por classe, `Reflector` em guard, `ValidationPipe` + class-validator funcionando em `bun src/main.ts` **e** em `bun test`.
- [ ] MikroORM com `EntitySchema`: `migration:up` → `down` → `up` via `bunx --bun mikro-orm` (confirmar que o runtime é o Bun no output do `debug`).
- [ ] `bunfig.toml` com threshold 80% e reporter `text` + `lcov`. Conferir que um threshold não atingido faz o comando sair com ≠ 0.
- [ ] Teste com 3× `Bun.spawn` + `SIGTERM`/`SIGKILL` + `afterAll` que mata todos. Sem processos órfãos (`pgrep -f src/main.ts` vazio).
- [ ] `docker stop` gera log de shutdown gracioso (prova de que o `SIGTERM` chegou ao PID 1).
- [ ] `exactOptionalPropertyTypes`: tentar ligar e documentar o resultado.
