/**
 * Popula o ambiente local com um caso de cada tipo, para inspecionar API, banco e filas.
 *   docker compose --profile tools up -d --wait && bun run demo
 * Usa a API pública (HTTP) e a fila `wager-transactions.fifo` (SQS), como um provedor faria.
 */
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { resolveQueueUrl } from '../src/shared/infrastructure/sqs/sqs-client.ts';

const API = process.env['DEMO_API_URL'] ?? 'http://localhost:43180';
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env['SQS_ENDPOINT'] ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const QUEUE = await resolveQueueUrl(sqs, process.env['SQS_WAGER_QUEUE'] ?? 'wager-transactions.fifo');
const run = randomUUID().slice(0, 8);

async function call(method: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-correlation-id': `demo-${run}`, ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function wallet(name: string, amount: string) {
  const playerId = randomUUID();
  const { body } = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  console.log(`wallet ${name.padEnd(5)} ${String(body['id'])}  saldo inicial ${amount}`);
  return { name, walletId: String(body['id']), playerId };
}

function tx(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: Record<string, string> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-${run}-${randomUUID().slice(0, 6)}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: `round-${run}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

async function submit(label: string, body: ReturnType<typeof tx>, key = `${body.providerId}:${body.externalTransactionId}`) {
  const { status, body: result } = await call('POST', '/wagering/transactions', body, key);
  const detail = result['failureCode'] ?? result['code'] ?? (result['idempotentReplay'] ? 'replay' : '');
  console.log(`  ${String(status).padEnd(4)} ${label.padEnd(44)} ${String(result['status'] ?? '').padEnd(18)} ${String(detail)}`);
  return body;
}

async function enqueue(label: string, body: string, groupId: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: randomUUID() }));
  console.log(`  SQS  ${label}`);
}

console.log(`\n== demo ${run} (correlationId demo-${run}) ==\n`);
const alice = await wallet('alice', '1000.00');
const bob = await wallet('bob', '100.00');
const carol = await wallet('carol', '0.00');

console.log('\nalice — fluxo completo');
const bet = await submit('BET 25.00', tx(alice, 'BET', '25.00'));
await submit('mesma BET de novo (replay idempotente)', bet);
await submit('mesma key, valor diferente (conflito)', { ...bet, money: { amount: '26.00', currency: 'BRL' } });
await submit('WIN 50.00 referenciando a BET', tx(alice, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId }));
await submit('LOSS 0.00', tx(alice, 'LOSS', '0.00'));
const bet2 = await submit('BET 10.00', tx(alice, 'BET', '10.00'));
await submit('REFUND da BET 10.00', tx(alice, 'REFUND', '10.00', { referenceExternalTransactionId: bet2.externalTransactionId }));

console.log('\nbob — disputa de saldo (§8)');
await Promise.all([submit('BET 80.00 (A, simultânea)', tx(bob, 'BET', '80.00')), submit('BET 80.00 (B, simultânea)', tx(bob, 'BET', '80.00'))]);

console.log('\ncarol — ROLLBACK chega antes da BET; a BET vem pela fila');
await call('POST', `/wallets/${carol.walletId}/reconciliation`);
const lateBetId = `bet-late-${run}`;
await submit('WIN 40.00', tx(carol, 'WIN', '40.00'));
await submit('ROLLBACK 15.00 antes da BET', tx(carol, 'ROLLBACK', '15.00', { referenceExternalTransactionId: lateBetId }));
const lateBet = tx(carol, 'BET', '15.00', { externalTransactionId: lateBetId });
await enqueue('BET 15.00 referenciada (WagerTransactionRequested)', JSON.stringify({
  messageId: `msg-${run}-late-bet`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...lateBet, idempotencyKey: `provider-a:${lateBetId}` },
}), carol.walletId);
await enqueue('mensagem malformada (vai para a DLQ)', `{"messageId":"msg-${run}-broken","type":"WagerTransactionRequested"`, carol.walletId);

await Bun.sleep(4_000); // consumer + worker de referências + publisher da outbox
console.log('\nresultado');
for (const w of [alice, bob, carol]) {
  const { body } = await call('POST', `/wallets/${w.walletId}/reconciliation`);
  const balance = body['storedBalance'] as { amount: string };
  console.log(`  ${w.name.padEnd(5)} saldo ${balance.amount.padStart(8)}  lançamentos ${String(body['checkedEntries']).padStart(2)}  consistente=${String(body['consistent'])}`);
}
const rollback = await call('GET', `/providers/provider-a/wagering/transactions/${lateBetId}`);
console.log(`  BET que chegou pela fila: ${String(rollback.body['status'])}`);
console.log(`\nwallets: ${[alice, bob, carol].map((w) => w.walletId).join(' ')}\n`);

// Usado pela página do ambiente de demonstração (DEMO_OUTPUT_FILE): lista as wallets geradas.
const output = process.env['DEMO_OUTPUT_FILE'];
if (output !== undefined) {
  const story = {
    alice: 'BET 25 → replay → conflito de key (409) → WIN 50 → LOSS → BET 10 → REFUND',
    bob: 'saldo 100 e duas BETs de 80 simultâneas: uma 201, outra 422 INSUFFICIENT_FUNDS',
    carol: 'WIN 40 → ROLLBACK chega antes da BET (202) → a BET vem pela fila → o worker resolve',
  };
  await Bun.write(
    output,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        expires: process.env['DEMO_EXPIRES'] ?? null,
        correlationId: `demo-${run}`,
        wallets: [alice, bob, carol].map((w) => ({ name: w.name, walletId: w.walletId, playerId: w.playerId, story: story[w.name as keyof typeof story] })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`demo salva em ${output}`);
}
sqs.destroy();
