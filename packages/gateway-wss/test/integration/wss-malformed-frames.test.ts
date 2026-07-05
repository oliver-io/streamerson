/**
 * Malformed-frame resilience (TESTING_ANALYSIS gateway-wss gap 5): a client
 * sending a non-JSON frame (or a JSON frame with no `token`) must not take the
 * gateway down. `deserializeWebsocketMessageToStreamEvent` rethrows the parse
 * error inside the async `message` handler — an unhandled rejection — so this
 * runs the gateway as a REAL subprocess (one per test, same fixture as the
 * redis-failure test) and asserts process survival + continued service.
 *
 * EXPECTED RED (non-JSON case): the gateway process exits 1 on the unhandled
 * rejection (verified: SyntaxError from wssapi.ts deserialize kills the
 * subprocess). The test asserts the intended survive-and-serve contract.
 * Requires Redis (`bun run start:redis`).
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource, Topic } from '@streamerson/core';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

type Fixture = { proc: ReturnType<typeof Bun.spawn>; port: number; topic: Topic };
const fixtures: Fixture[] = [];
let redis: StreamingDataSource | undefined;

async function spawnGateway(tag: string): Promise<Fixture> {
  const port = 19950 + Math.floor(Math.random() * 400);
  const topicName = `malformed-${tag}-${Date.now()}`;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', `${import.meta.dir}/fixtures/wss-server-fixture.ts`],
    env: { ...process.env, WSS_FIXTURE_PORT: String(port), WSS_FIXTURE_TOPIC: topicName },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Date.now() + 10000;
  while (!buffered.includes('READY')) {
    if (Date.now() > deadline) throw new Error(`fixture never became ready: ${buffered}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`fixture exited before READY: ${buffered}`);
    buffered += decoder.decode(value);
  }
  reader.releaseLock();
  const fixture = { proc, port, topic: new Topic({ namespace: 'wss-itest', topic: topicName }) };
  fixtures.push(fixture);
  return fixture;
}

afterAll(async () => {
  redis = new StreamingDataSource(REDIS);
  await redis.connect();
  for (const f of fixtures) {
    try { f.proc.kill(); } catch { /* ignore */ }
    try { await redis.client.send('DEL', [f.topic.consumerKey()]); } catch { /* ignore */ }
    try { await redis.client.send('DEL', [f.topic.producerKey()]); } catch { /* ignore */ }
  }
  try { await redis.disconnect(); } catch { /* ignore */ }
});

function openSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/echo`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`ws connect failed: ${String(e)}`));
  });
}

async function assertServerAlive(f: Fixture, context: string) {
  const exited = f.proc.exited.then((code) => ({ exited: true as const, code }));
  const probe = (async () => {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`http://localhost:${f.port}/nope`);
    return { exited: false as const, status: res.status };
  })();
  const outcome = await Promise.race([exited, probe]);
  if (outcome.exited) {
    const stderr = await new Response(f.proc.stderr).text();
    expect().fail(`${context}: gateway process died (exit ${outcome.code}). stderr tail: ${stderr.slice(-400)}`);
  } else {
    expect(outcome.status).toBe(404);
  }
}

test('a non-JSON frame does not kill the gateway', async () => {
  const f = await spawnGateway('nonjson');
  const ws = await openSocket(f.port);
  ws.send('this is not json {');
  await assertServerAlive(f, 'non-JSON frame');
  try { ws.close(); } catch { /* ignore */ }
}, 20000);

test('a JSON frame with no token does not kill the gateway', async () => {
  const f = await spawnGateway('notoken');
  const ws = await openSocket(f.port);
  ws.send(JSON.stringify({ hello: 'no token here' }));
  await assertServerAlive(f, 'token-less frame');
  try { ws.close(); } catch { /* ignore */ }
}, 20000);
