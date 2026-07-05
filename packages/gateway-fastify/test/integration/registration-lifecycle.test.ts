/**
 * Registration/lifecycle-level behavioral tests for CreateGatewayPlugin — no HTTP
 * dispatch (every dispatch is blocked by confirmed bug #7: under Bun `request.raw`
 * emits 'close' immediately, aborting the request; see http-roundtrip.test.ts).
 *
 * Connection accounting uses `INFO clients` → `connected_clients:<n>` (a tiny reply)
 * instead of a whole-list CLIENT LIST scan: under a full `bun test` run the server
 * holds ~180 clients and Bun 1.3.x's RedisClient desyncs on the large CLIENT LIST
 * reply (ERR_REDIS_INVALID_RESPONSE). Because the global count can shift from
 * background noise (worker threads from other packages), each measurement is a
 * full register→count→close→count cycle retried up to 3 times; a real leak fails
 * all attempts deterministically. One topic-binding = read + write
 * StreamingDataSource, each `controllable: true` (data + control connection) = 4
 * Redis connections. Requires Redis.
 */
import Fastify from 'fastify';
import { CreateGatewayPlugin } from '../../src/stream-plugin';
import { StreamingDataSource, Topic } from '@streamerson/core';
import { test, expect, beforeAll, afterAll } from 'bun:test';

const REDIS = { host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost', port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379) };
const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let admin: StreamingDataSource;
beforeAll(async () => {
  admin = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet });
  await admin.connect();
});
afterAll(async () => { try { await admin.disconnect(); } catch { /* */ } });

async function connectedClients(): Promise<number> {
  const info = String(await admin.client.send('INFO', ['clients']));
  const n = info.match(/connected_clients:(\d+)/)?.[1];
  if (!n) throw new Error('INFO clients: connected_clients not found');
  return Number(n);
}

/** Bounded poll: true when cond holds, false at deadline. */
async function until(cond: () => Promise<boolean>, deadlineMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/**
 * One register→count→close→count measurement cycle. Returns true when the global
 * connection count rose by exactly `expectedDelta` after registration AND returned
 * to this attempt's own baseline within 2s of close. Callers retry up to 3 times
 * (fresh Fastify instance each attempt) to ride out background count noise.
 */
async function cycleShowsDelta(
  expectedDelta: number,
  makeServer: () => Promise<{ close(): Promise<unknown> }>,
): Promise<boolean> {
  const baseline = await connectedClients();
  const server = await makeServer();
  const opened = (await connectedClients()) - baseline;
  await server.close();
  const returned = await until(async () => (await connectedClients()) === baseline, 2000);
  return opened === expectedDelta && returned;
}

const plugin = (topic: Topic, routes: any) => CreateGatewayPlugin({
  logger: quiet,
  streamOptions: { redisConfiguration: REDIS } as any,
  topic,
  routes,
});

test('awaiter dedup: two routes on one topic share one binding — exactly 4 connections, not 8', async () => {
  // Both routes resolve to the same `${responseStream}:${messageStream}` binding, so
  // getStreamAwaiter reuses one awaiter (one read + one write channel, 2 conns each).
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    const topic = new Topic({ namespace: `reg-dedup-${uniq()}`, topic: 'T' });
    ok = await cycleShowsDelta(4, async () => {
      const server = Fastify({ logger: false });
      await server.register(plugin(topic, [
        { method: 'POST', url: '/one', messageType: 'm1' },
        { method: 'POST', url: '/two', messageType: 'm2' },
      ]));
      await server.ready();
      expect(server.hasRoute({ method: 'POST', url: '/one' })).toBe(true);
      expect(server.hasRoute({ method: 'POST', url: '/two' })).toBe(true);
      return server;
    });
  }
  expect(ok).toBe(true);
}, 20000);

test('two topics: two bindings — 8 connections, registration resolves (readers armed), close releases all', async () => {
  // register() awaiting successfully IS the "readers armed" contract: the plugin
  // awaits readResponseStream() for every tracker before registration resolves.
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    const tA = new Topic({ namespace: `reg-two-${uniq()}`, topic: 'A' });
    const tB = new Topic({ namespace: `reg-two-${uniq()}`, topic: 'B' });
    // 2 bindings x (read + write) x (data + control) = 8
    ok = await cycleShowsDelta(8, async () => {
      const server = Fastify({ logger: false });
      await server.register(plugin(tA, [
        { method: 'POST', url: '/a', messageType: 'ma', topic: tA },
        { method: 'POST', url: '/b', messageType: 'mb', topic: tB },
      ]));
      await server.ready();
      return server;
    });
  }
  expect(ok).toBe(true);
}, 20000);

test('leak guard: 5 register+close cycles each return the connection count to baseline', async () => {
  for (let cycle = 0; cycle < 5; cycle++) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const topic = new Topic({ namespace: `reg-cycle-${uniq()}`, topic: `C${cycle}` });
      ok = await cycleShowsDelta(4, async () => {
        const server = Fastify({ logger: false });
        await server.register(plugin(topic, [{ method: 'POST', url: '/x', messageType: 'go' }]));
        await server.ready();
        return server;
      });
    }
    expect(ok).toBe(true);
  }
}, 40000);

test('two separate plugin instances (topics A, B) on one fastify instance register cleanly and close tears both down', async () => {
  // INTENDED CONTRACT — currently RED (product defect, proven vs harness):
  // stream-plugin.ts calls `fastify.decorateRequest('sourceId', '')` unconditionally,
  // and fp() de-encapsulates the plugin, so the SECOND CreateGatewayPlugin instance
  // re-decorates the shared root and fastify throws FST_ERR_DEC_ALREADY_PRESENT
  // ("The decorator 'sourceId' has already been added!") — verified by an isolated
  // probe with two fresh plugin instances outside bun:test. The fix belongs in src
  // (guard with hasRequestDecorator), out of scope here; test pins the intended
  // multi-gateway composition contract.
  const tA = new Topic({ namespace: `reg-multi-${uniq()}`, topic: 'A' });
  const tB = new Topic({ namespace: `reg-multi-${uniq()}`, topic: 'B' });
  const server = Fastify({ logger: false });
  let registerError: any;
  let closeError: any;
  try {
    await server.register(plugin(tA, [{ method: 'POST', url: '/a', messageType: 'ma' }]));
    await server.register(plugin(tB, [{ method: 'POST', url: '/b', messageType: 'mb' }]));
    await server.ready();
  } catch (e) {
    registerError = e;
  } finally {
    // Teardown always runs so plugin A's 4 connections are released even on RED.
    try { await server.close(); } catch (e) { closeError = e; }
  }
  expect(registerError).toBeUndefined();
  expect(server.hasRoute({ method: 'POST', url: '/a' })).toBe(true);
  expect(server.hasRoute({ method: 'POST', url: '/b' })).toBe(true);
  expect(closeError).toBeUndefined();
}, 20000);

test('same plugin instance registered twice fails loudly (no silent double-arm)', async () => {
  // Pinned observed behavior: fp() (no name/dedup metadata) does NOT dedupe the
  // second registration — the plugin function runs again, hits decorateRequest
  // first, and fastify rejects with FST_ERR_DEC_ALREADY_PRESENT before any route
  // or channel is provisioned a second time. Loud failure precedes double-arming
  // the tracker, so there is no doubled-delivery hazard: the error fires before
  // getStreamAwaiter/readResponseStream on the second pass (decorateRequest is the
  // first statement of the plugin body).
  const topic = new Topic({ namespace: `reg-dup-${uniq()}`, topic: 'T' });
  const p = plugin(topic, [{ method: 'POST', url: '/x', messageType: 'go' }]);
  const server = Fastify({ logger: false });
  await server.register(p);
  let err: any;
  try {
    await server.register(p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.code).toBe('FST_ERR_DEC_ALREADY_PRESENT');
  await server.close();
}, 20000);
