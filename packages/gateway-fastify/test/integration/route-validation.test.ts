/**
 * GW14 (FASTIFY_GATEWAY_REVIEW.md) — the handler casts `route.messageType as MessageType`
 * with no check. A route missing `messageType` dispatches `undefined`, which no worker
 * handler matches → a guaranteed *silent* timeout at request time (a 500 after the full
 * timeout, with nothing to indicate the route was misconfigured).
 *
 * Contract under test: a route without `messageType` is a configuration error and must be
 * rejected at REGISTRATION (loudly), not deferred to a silent per-request timeout. Written
 * first per docs/specs/TESTING.md #10; RED until the registration-time validation exists.
 *
 * Validation runs before any channel is opened, so this needs no Redis.
 */
import Fastify from 'fastify';
import { CreateGatewayPlugin } from '../../src/stream-plugin';
import { Topic } from '@streamerson/core';
import { test, expect } from 'bun:test';

const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;

test('GW14: a route missing messageType is rejected at registration', async () => {
  const server = Fastify({ logger: false });
  server.register(CreateGatewayPlugin({
    logger: quiet,
    topic: new Topic('gw14-missing-type'),
    routes: [{ method: 'POST', url: '/x' } as any], // <- no messageType
  }));

  // Fastify surfaces plugin-load errors at ready(). RED today: no validation → ready()
  // resolves; GREEN: ready() rejects with a clear, messageType-naming configuration error.
  await expect(server.ready()).rejects.toThrow(/messageType/i);
  try { await server.close(); } catch { /* */ }
});

test('GW14: a valid route (messageType present) still registers cleanly', async () => {
  const server = Fastify({ logger: false });
  server.register(CreateGatewayPlugin({
    logger: quiet,
    streamOptions: { redisConfiguration: { host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost', port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379) } } as any,
    topic: new Topic('gw14-valid-type'),
    routes: [{ method: 'POST', url: '/x', messageType: 'go' }],
  }));
  await server.ready(); // must NOT throw
  try { await server.close(); } catch { /* */ }
}, 15000);
