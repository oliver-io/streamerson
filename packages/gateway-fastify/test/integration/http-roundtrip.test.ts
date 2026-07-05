/**
 * End-to-end gateway-fastify integration (TESTING_ANALYSIS correlation gaps 1,
 * 2-partial, 11; punch-list P1-9): real HTTP -> plugin -> [CONSUMER stream] ->
 * real echo worker -> [PRODUCER stream] -> correlation -> real HTTP response.
 *
 * Real Redis, real `fastify.listen({ port: 0 })`, real `fetch` (the Q10 harness
 * the spec approved but never built), a hand-rolled core-primitives echo worker.
 * No mocks. Requires Redis (`bun run start:redis`).
 *
 * EXPECTED RED (all 3 tests) — real product bug found by this suite: under Bun's
 * node:http, `request.raw` emits `'close'` immediately after the request body is
 * consumed (verified standalone: 'close' at +1ms with `reply.sent === false`,
 * plain Fastify, no streamerson code). The plugin's client-disconnect wiring
 * (`stream-plugin.ts` — `request.raw.on('close', ...) -> ac.abort()`) therefore
 * aborts EVERY dispatch instantly; the CANCELLED error is swallowed by the
 * `client disconnected` mapping and every request returns 200 with a null body
 * without ever consulting a worker. The gateway request path is inoperative under
 * Bun. These tests assert the intended contract and stay failing until the
 * disconnect wiring uses a signal that actually means "client gone" (e.g.
 * `request.raw.socket`'s close, or Fastify's onRequestAbort hook).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import Fastify, { FastifyInstance } from 'fastify';
import { StreamingDataSource, Topic } from '@streamerson/core';
import type { MappedStreamEvent, MessageType } from '@streamerson/core';
import { CreateGatewayPlugin } from '../../src/stream-plugin';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
};

const topic = new Topic({ namespace: 'gwf-itest', topic: `http-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });

let server: FastifyInstance;
let base: string;
let echo: StreamingDataSource;
let responder: StreamingDataSource;

beforeAll(async () => {
  // Echo worker over core primitives: answer `echo`-typed requests on the
  // producer stream, correlated by messageId. Deliberately never answers the
  // `blackhole` type (drives the dispatch-timeout -> HTTP 500 mapping).
  echo = new StreamingDataSource({ ...REDIS, controllable: true });
  responder = new StreamingDataSource({ ...REDIS, controllable: true });
  await Promise.all([echo.connect(), responder.connect()]);
  const requests = echo.getReadStream({ stream: topic.consumerKey(), last: '0' });
  requests.on('data', (event: MappedStreamEvent) => {
    if (event.messageType !== 'echo') return;
    void responder.writeToStream({
      outgoingStream: topic.producerKey(),
      incomingStream: topic.consumerKey(),
      messageType: 'RESPONSE' as MessageType,
      messageId: event.messageId,
      message: JSON.stringify({ echoed: event.payload }),
      sourceId: event.messageSourceId,
    });
  });

  server = Fastify({ logger: false });
  await server.register(CreateGatewayPlugin({
    topic,
    streamOptions: { redisConfiguration: REDIS },
    routes: [
      { method: 'POST', url: '/echo', messageType: 'echo', timeout: 5000 },
      { method: 'POST', url: '/blackhole', messageType: 'blackhole', timeout: 500 },
    ],
  }));
  await server.listen({ port: 0 });
  const addr = server.addresses().find((a) => a.family === 'IPv4') ?? server.addresses()[0];
  base = `http://${addr.address === '::' ? 'localhost' : addr.address}:${addr.port}`;
});

afterAll(async () => {
  try { await server.close(); } catch { /* ignore */ }
  try { echo.abort(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
  try { await responder.client.send('DEL', [topic.consumerKey()]); } catch { /* ignore */ }
  try { await responder.client.send('DEL', [topic.producerKey()]); } catch { /* ignore */ }
  try { await echo.disconnect(); } catch { /* ignore */ }
  try { await responder.disconnect(); } catch { /* ignore */ }
});

test('POST round-trip: HTTP request is answered with the worker\'s correlated response', async () => {
  const res = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 42 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ echoed: { value: 42 } });
}, 15000);

test('N concurrent dispatches each receive their own response (correlation under concurrency)', async () => {
  const N = 10;
  const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: i }),
    });
    return { status: res.status, body: await res.json() };
  }));
  for (let i = 0; i < N; i++) {
    expect(results[i].status).toBe(200);
    expect(results[i].body).toEqual({ echoed: { n: i } });
  }
}, 20000);

test('a request no worker answers times out to an intelligible HTTP 500 (not a hang)', async () => {
  const started = Date.now();
  const res = await fetch(`${base}/blackhole`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ into: 'the void' }),
  });
  const elapsed = Date.now() - started;
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.statusCode).toBe(500);
  // Bounded by the route's dispatch timeout (500ms) plus slack — not a hang.
  expect(elapsed).toBeLessThan(5000);
}, 15000);
