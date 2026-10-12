import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

/**
 * Guarda da regra eliminatória §5.1/§14 ("number para dinheiro"): o código que manipula
 * dinheiro não pode converter valores para ponto flutuante. Varre as camadas de domínio e
 * falha apontando arquivo e linha. Novas camadas monetárias entram em MONETARY_GLOBS.
 */
const MONETARY_GLOBS = [
  'src/**/domain/**/*.ts',
  // Camadas de infraestrutura que tocam dinheiro (mappers, DTOs, consumer).
  'src/**/persistence/**/*.ts',
  'src/**/http/**/*.ts',
  'src/**/sqs/**/*.ts',
];

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'parseFloat', pattern: /\bparseFloat\s*\(/ },
  { name: 'parseInt', pattern: /\bparseInt\s*\(/ },
  { name: 'Number(...)', pattern: /\bNumber\s*\(/ },
  { name: 'Math.*', pattern: /\bMath\./ },
  { name: 'toFixed (float)', pattern: /\.toFixed\s*\(/ },
  { name: '+ unário', pattern: /(^|[=(,:?\[]|return)\s*\+\s*[A-Za-z_$(]/ },
  { name: 'type number em campo monetário', pattern: /\b(amount|balance|money|minor\w*)\s*[?]?:\s*number\b/i },
];

async function monetaryFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of MONETARY_GLOBS) {
    for await (const file of new Glob(pattern).scan({ cwd: process.cwd() })) files.push(file);
  }
  return files.sort();
}

describe('guarda: dinheiro nunca passa por number/float', () => {
  test('existem arquivos monetários sendo verificados', async () => {
    const files = await monetaryFiles();
    expect(files).toContain('src/shared/domain/money.ts');
    expect(files.length).toBeGreaterThan(5);
  });

  test('nenhuma conversão proibida no código monetário', async () => {
    const violations: string[] = [];
    for (const file of await monetaryFiles()) {
      const lines = (await Bun.file(file).text()).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(code)) violations.push(`${file}:${index + 1} — ${name}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test('o detector reconhece cada padrão proibido', () => {
    const samples = [
      'const v = parseFloat(amount);',
      'const v = parseInt(amount, 10);',
      'const v = Number(amount);',
      'const v = Math.round(x);',
      'const s = value.toFixed(2);',
      'const v = +amount;',
      'amount: number;',
    ];
    for (const sample of samples) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(true);
    }
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('const total = a + b;'))).toBe(false);
  });
});
