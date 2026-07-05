/**
 * Behavioral integration tests for the WSS gateway request path
 * (TESTING_ANALYSIS gateway-wss gaps 1 & 2; P1-10 regression guard for the
 * `topic.loopback()` fix):
 *
 *   WS client frame -> gateway -> [CONSUMER stream] -> echo worker
 *                   -> [PRODUCER stream] -> gateway -> same WS client
 *
 * Real Redis, real `Bun.serve` on an ephemeral port, real WebSocket clients,
 * a real (hand-rolled, core-primitives-only) echo worker. No mocks.
 *
 * The token-hijack test asserts the *secure* contract (a socket must not
 * receive another token's responses merely by claiming that token) and is
 * EXPECTED TO FAIL until token->identity binding is decided/implemented
 * (confirmed audit bug #6, second half). Requires Redis (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource, Topic } from '@streamerson/core';
import type { MappedStreamEvent, MessageType } from '@streamerson/core';
import { WebSocketServer } from '../../src/wssapi';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const topic = new Topic({ namespace: 'wss-itest', topic: `roundtrip-${Date.now()}` });
const PORT = 19100 + Math.floor(Math.random() * 500);

let wss: WebSocketServer;
let echo: StreamingDataSource;
let responder: StreamingDataSource;

/** A WS client wrapper that resolves queued incoming messages, event-driven. */
class Client {
  ws: WebSocket;
  private queue: any[] = [];
  private waiters: Array<(m: any) => void> = [];

  constructor(path: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}${path}`);
    this.ws.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data));
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.queue.push(parsed);
    };
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
  }

  send(frame: Record<string, unknown>) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Next message within `ms`, else null (bounded, no dangling waiter side effects beyond scope). */
  next(ms: number): Promise<any | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      const waiter = (m: any) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

beforeAll(async () => {
  // Echo worker over core primitives: tail the topic's consumer stream from '0'
  // (loss-free for the test window) and answer on the producer stream, echoing
  // the payload and preserving messageSourceId — the field the gateway routes by.
  echo = new StreamingDataSource(REDIS);
  responder = new StreamingDataSource(REDIS);
  await Promise.all([echo.connect(), responder.connect()]);
  const requests = echo.getReadStream({ stream: topic.consumerKey(), last: '0' });
  requests.on('data', (event: MappedStreamEvent) => {
    void responder.writeToStream({
      outgoingStream: topic.producerKey(),
      incomingStream: topic.consumerKey(),
      messageType: 'RESPONSE' as MessageType,
      messageId: event.messageId,
      message: JSON.stringify({ echoed: event.payload }),
      sourceId: event.messageSourceId,
    });
  });

  wss = new WebSocketServer({ port: PORT });
  await wss.streamRoute('/echo', 'itest', topic, { authenticate: () => true });
  await wss.listen();
});

afterAll(async () => {
  try { wss.stop(); } catch { /* ignore */ }
  try { echo.abort(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
  try { await responder.client.send('DEL', [topic.consumerKey()]); } catch { /* ignore */ }
  try { await responder.client.send('DEL', [topic.producerKey()]); } catch { /* ignore */ }
  try { await echo.disconnect(); } catch { /* ignore */ }
  try { await responder.disconnect(); } catch { /* ignore */ }
});

test('unknown path is 404, failed auth is 401', async () => {
  const notFound = await fetch(`http://localhost:${PORT}/nope`);
  expect(notFound.status).toBe(404);

  const guarded = new Topic({ namespace: 'wss-itest', topic: `auth-${Date.now()}` });
  await wss.streamRoute('/guarded', 'itest', guarded, { authenticate: () => false });
  const unauthorized = await fetch(`http://localhost:${PORT}/guarded`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
  expect(unauthorized.status).toBe(401);
});

test('round-trip: a frame sent over WS comes back to the same socket with its payload', async () => {
  const client = new Client('/echo');
  await client.open();
  client.send({ token: 'tok-roundtrip', value: 42 });

  const response = await client.next(5000);
  client.close();

  expect(response).not.toBeNull();
  expect(response.echoed).toEqual({ value: 42 });
  expect(typeof response.messageId).toBe('string');
}, 15000);

test('routing isolation: two clients with distinct tokens each receive only their own responses', async () => {
  const a = new Client('/echo');
  const b = new Client('/echo');
  await Promise.all([a.open(), b.open()]);

  // Interleave sends both ways.
  a.send({ token: 'tok-A', from: 'A', n: 1 });
  b.send({ token: 'tok-B', from: 'B', n: 1 });
  b.send({ token: 'tok-B', from: 'B', n: 2 });
  a.send({ token: 'tok-A', from: 'A', n: 2 });

  const aGot = [await a.next(5000), await a.next(5000)];
  const bGot = [await b.next(5000), await b.next(5000)];

  // Each client got exactly its own two responses...
  for (const m of aGot) {
    expect(m).not.toBeNull();
    expect(m.echoed.from).toBe('A');
  }
  for (const m of bGot) {
    expect(m).not.toBeNull();
    expect(m.echoed.from).toBe('B');
  }
  // ...and nothing extra leaked across.
  expect(await a.next(500)).toBeNull();
  expect(await b.next(500)).toBeNull();

  a.close();
  b.close();
}, 20000);

test('token hijack: a socket claiming another client\'s token must not receive that client\'s responses', async () => {
  const victim = new Client('/echo');
  const attacker = new Client('/echo');
  await Promise.all([victim.open(), attacker.open()]);

  // Attacker claims the victim's token by sending any frame with it; the gateway
  // subscribes the attacker's socket to that token with no identity binding.
  attacker.send({ token: 'tok-victim', probe: true });
  // Attacker receives the echo of its own probe; drain it.
  expect(await attacker.next(5000)).not.toBeNull();

  victim.send({ token: 'tok-victim', secret: 'hunter2' });

  const victimGot = await victim.next(5000);
  expect(victimGot).not.toBeNull();
  expect(victimGot.echoed).toEqual({ secret: 'hunter2' });

  // Intended contract: the attacker must NOT observe the victim's response.
  const leaked = await attacker.next(1000);
  expect(leaked).toBeNull();

  victim.close();
  attacker.close();
}, 20000);
