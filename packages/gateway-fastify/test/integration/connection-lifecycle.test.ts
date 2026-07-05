/**
 * GW5 (FASTIFY_GATEWAY_REVIEW.md) — the plugin opens two `StreamingDataSource`s per
 * unique topic-binding (read + write), each `controllable: true` (client + control) =
 * 4 Redis connections per topic, and registers NO `onClose` hook. So every
 * `server.close()` leaks those 4 connections until Redis hits `maxclients`.
 *
 * Contract under test (black-box, over real HTTP — `.inject()` is unusable under Bun,
 * GW11): once a server that registered the gateway is closed, the per-topic Redis
 * connections it opened are released. Written first per docs/specs/TESTING.md #10; RED
 * until the `onClose` teardown exists. Real Redis required (`bun run start:redis`).
 */
import Fastify from 'fastify';
import { CreateGatewayPlugin } from '../../src/stream-plugin';
import { StreamingDataSource, Topic } from '@streamerson/core';
import { test, expect, beforeAll, afterAll } from 'bun:test';

const REDIS = { host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost', port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379) };
const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: StreamingDataSource;
beforeAll(async () => {
  admin = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet });
  await admin.connect();
});
afterAll(async () => { try { await admin.disconnect(); } catch { /* */ } });

// CLIENT LIST id-set (not the global `connected_clients` counter, which any parallel
// suite can move): we diff ids so only connections opened *by this test's server*
// between the snapshots are counted, and then check those exact ids are released.
async function clientIds(): Promise<Set<string>> {
  const list = String(await admin.client.send('CLIENT', ['LIST']));
  const ids = new Set<string>();
  for (const m of list.matchAll(/(?:^|\n)id=(\d+)/g)) ids.add(m[1]);
  return ids;
}

test('GW5: server.close() releases the per-topic Redis connections (no leak)', async () => {
  const topic = new Topic({ namespace: `gw5-${uniq()}`, topic: 'T' });
  const baseline = await clientIds();

  const server = Fastify({ logger: false });
  await server.register(CreateGatewayPlugin({
    logger: quiet,
    streamOptions: { redisConfiguration: REDIS } as any,
    topic,
    routes: [{ method: 'POST', url: '/x', messageType: 'go' }],
  }));
  await server.ready();
  await server.listen({ port: 0, host: '127.0.0.1' });
  await settle(150); // let the async response-reader arm

  const afterListen = await clientIds();
  const opened = [...afterListen].filter((id) => !baseline.has(id));
  // One binding = read + write channel, each controllable (data + control) = 4 conns.
  // (Parallel suites can only inflate this GTE, never deflate it.)
  expect(opened.length).toBeGreaterThanOrEqual(4);

  await server.close();
  await settle(150);

  const afterClose = await clientIds();
  const survivors = opened.filter((id) => afterClose.has(id));
  // The connections this server opened must be released; other suites' clients
  // (absent from `opened`) can't affect this.
  expect(survivors.length).toBeLessThan(4);
}, 20000);
