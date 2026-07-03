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

async function connectedClients(): Promise<number> {
  const info = String(await admin.client.send('INFO', ['clients']));
  const m = info.match(/connected_clients:(\d+)/);
  return m ? Number(m[1]) : NaN;
}

test('GW5: server.close() releases the per-topic Redis connections (no leak)', async () => {
  const topic = new Topic({ namespace: `gw5-${uniq()}`, topic: 'T' });
  const baseline = await connectedClients();

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

  const afterListen = await connectedClients();
  // One binding = read + write channel, each controllable (data + control) = 4 conns.
  expect(afterListen - baseline).toBeGreaterThanOrEqual(4);

  await server.close();
  await settle(150);

  const afterClose = await connectedClients();
  // RED today: the 4 are NOT released (afterClose ≈ baseline + 4). GREEN: released.
  expect(afterClose - baseline).toBeLessThan(4);
}, 20000);
