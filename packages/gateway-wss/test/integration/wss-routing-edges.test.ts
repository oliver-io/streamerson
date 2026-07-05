/**
 * WSS gateway routing edge cases (style of wss-roundtrip.test.ts): one real
 * `Bun.serve` gateway on an ephemeral port, one hand-rolled core-primitives echo
 * worker per topic, real WebSocket clients, real Redis. No mocks.
 * Requires Redis (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource, Topic } from '@streamerson/core';
import type { MappedStreamEvent, MessageType } from '@streamerson/core';
import { WebSocketServer, StreamSocket } from '../../src/wssapi';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const PORT = 19650 + Math.floor(Math.random() * 200);
const stamp = Date.now();
const topicA = new Topic({ namespace: 'wss-itest', topic: `edges-a-${stamp}` });
const topicB = new Topic({ namespace: 'wss-itest', topic: `edges-b-${stamp}` });
const topicRaw = new Topic({ namespace: 'wss-itest', topic: `edges-raw-${stamp}` });
const topicHooks = new Topic({ namespace: 'wss-itest', topic: `edges-hooks-${stamp}` });
const allTopics = [topicA, topicB, topicRaw, topicHooks];

let wss: WebSocketServer;
let admin: StreamingDataSource;
const workers: StreamingDataSource[] = [];

/** Echo worker over core primitives: consumer stream in, producer stream out. */
async function spawnWorker(topic: Topic, respond: (event: MappedStreamEvent) => string) {
  const reader = new StreamingDataSource(REDIS);
  const writer = new StreamingDataSource(REDIS);
  await Promise.all([reader.connect(), writer.connect()]);
  workers.push(reader, writer);
  reader.getReadStream({ stream: topic.consumerKey(), last: '0' }).on('data', (event: MappedStreamEvent) => {
    void writer.writeToStream({
      outgoingStream: topic.producerKey(),
      incomingStream: topic.consumerKey(),
      messageType: 'RESPONSE' as MessageType,
      messageId: event.messageId,
      message: respond(event),
      sourceId: event.messageSourceId,
    });
  });
}

/** WS client wrapper resolving queued incoming messages, event-driven (wss-roundtrip style). */
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

/** Bounded event-driven wait on a predicate. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

// Route-hook recording for /hooks (test g).
const hookLog = { opens: 0, closes: 0, messages: [] as MappedStreamEvent[] };

beforeAll(async () => {
  admin = new StreamingDataSource(REDIS);
  await admin.connect();

  // Tagging workers echo the raw deserialized event so tests can assert exactly
  // what the gateway put on the wire (payload contents, messageSourceId).
  const tagger = (tag: string) => (event: MappedStreamEvent) => JSON.stringify({
    tag,
    echoed: event.payload,
    seenSourceId: event.messageSourceId,
    hadTokenKey: Object.prototype.hasOwnProperty.call(event.payload, 'token'),
  });
  await spawnWorker(topicA, tagger('A'));
  await spawnWorker(topicB, tagger('B'));
  // Raw worker: responds with the payload verbatim (for empty/{a:null} responses).
  await spawnWorker(topicRaw, (event) => JSON.stringify(event.payload));
  await spawnWorker(topicHooks, tagger('H'));

  wss = new WebSocketServer({ port: PORT });
  await wss.streamRoute('/a', 'itest', topicA, { authenticate: () => true });
  await wss.streamRoute('/b', 'itest', topicB, { authenticate: () => true });
  await wss.streamRoute('/raw', 'itest', topicRaw, { authenticate: () => true });
  await wss.streamRoute('/hooks', 'itest', topicHooks, {
    authenticate: () => true,
    onOpen: () => { hookLog.opens++; },
    onClose: () => { hookLog.closes++; },
    onMessage: (_ws: StreamSocket, message: MappedStreamEvent) => { hookLog.messages.push(message); },
  });
  await wss.listen();

  // Prime every route before any test runs. The gateway's loopback reader tails
  // from '$', and the tip is resolved at its FIRST blocking read — under a loaded
  // full-suite run a response can be written before the reader parks and is then
  // dropped forever (documented join-window semantics). A re-sent probe converges
  // once the reader is live; this removes the arm-up race from every test below.
  for (const path of ['/a', '/b', '/raw', '/hooks']) {
    const probe = new Client(path);
    await probe.open();
    let primed = false;
    for (let attempt = 0; attempt < 10 && !primed; attempt++) {
      probe.send({ token: `prime-${path.slice(1)}`, prime: true });
      primed = (await probe.next(1000)) !== null;
    }
    probe.close();
    if (!primed) throw new Error(`route ${path} never primed`);
  }
  // Reset the streams so per-test XLEN/hook assertions see only their own traffic.
  for (const t of allTopics) {
    await admin.client.send('DEL', [t.consumerKey()]).catch(() => {});
  }
  hookLog.opens = 0;
  hookLog.closes = 0;
  hookLog.messages.length = 0;
});

afterAll(async () => {
  try { wss.stop(); } catch { /* ignore */ }
  for (const w of workers) { try { w.abort(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 150));
  for (const t of allTopics) {
    try { await admin.client.send('DEL', [t.consumerKey()]); } catch { /* ignore */ }
    try { await admin.client.send('DEL', [t.producerKey()]); } catch { /* ignore */ }
  }
  for (const w of workers) { try { await w.disconnect(); } catch { /* ignore */ } }
  try { await admin.disconnect(); } catch { /* ignore */ }
});

test('multi-path isolation: a frame on /a is answered by topic A and never touches topic B\'s stream', async () => {
  const client = new Client('/a');
  await client.open();
  client.send({ token: 'iso-1', from: 'a-side' });

  const response = await client.next(5000);
  client.close();

  expect(response).not.toBeNull();
  expect(response.tag).toBe('A');
  expect(response.echoed).toEqual({ from: 'a-side' });
  // Topic B's consumer stream never saw an entry (XLEN counts stored entries
  // regardless of reads; 0 for a nonexistent key).
  expect(Number(await admin.client.send('XLEN', [topicB.consumerKey()]))).toBe(0);
}, 15000);

test('token strip + sourceId: token becomes messageSourceId and is removed from the payload', async () => {
  const client = new Client('/a');
  await client.open();
  client.send({ token: 't1', hello: 'x' });

  const response = await client.next(5000);
  client.close();

  expect(response).not.toBeNull();
  expect(response.seenSourceId).toBe('t1');
  expect(response.hadTokenKey).toBe(false);
  expect(response.echoed).toEqual({ hello: 'x' });
}, 15000);

test('binary frame: the same JSON sent as an ArrayBuffer round-trips identically (Buffer decode branch)', async () => {
  const client = new Client('/a');
  await client.open();
  const bytes = new TextEncoder().encode(JSON.stringify({ token: 't-bin', hello: 'x' }));
  client.ws.send(bytes.buffer as ArrayBuffer);

  const response = await client.next(5000);
  client.close();

  expect(response).not.toBeNull();
  expect(response.seenSourceId).toBe('t-bin');
  expect(response.echoed).toEqual({ hello: 'x' });
}, 15000);

test('shared token on two sockets: responses fan out to every subscriber of that token', async () => {
  // Documented shared-subscription semantics: the gateway routes responses with
  // `server.publish(token, ...)`, a pub/sub fan-out over all sockets subscribed to
  // that token — a socket subscribes on its FIRST send carrying the token. This is
  // the same mechanism the wss-roundtrip token-hijack RED test flags as a security
  // gap (no token->identity binding); here we pin the fan-out itself as behavior.
  const c1 = new Client('/a');
  const c2 = new Client('/a');
  await Promise.all([c1.open(), c2.open()]);

  // c1 subscribes to 'shared' with its first frame; c2 is not yet subscribed, so
  // only c1 sees this response (drives the sequencing deterministically).
  c1.send({ token: 'shared', n: 'w1' });
  const w1 = await c1.next(5000);
  expect(w1?.echoed?.n).toBe('w1');

  // c2's first frame subscribes it; now BOTH sockets hold the 'shared' topic.
  c2.send({ token: 'shared', n: 'w2' });
  const [c1w2, c2w2] = await Promise.all([c1.next(5000), c2.next(5000)]);
  expect(c1w2?.echoed?.n).toBe('w2');
  expect(c2w2?.echoed?.n).toBe('w2');

  // And a subsequent frame from either socket fans out to both.
  c1.send({ token: 'shared', n: 'f3' });
  const [c1f3, c2f3] = await Promise.all([c1.next(5000), c2.next(5000)]);
  expect(c1f3?.echoed?.n).toBe('f3');
  expect(c2f3?.echoed?.n).toBe('f3');

  c1.close();
  c2.close();
}, 20000);

test('empty and null-bearing response payloads survive the data handler', async () => {
  const client = new Client('/raw');
  await client.open();

  // Worker echoes the payload verbatim; the frame {token} yields payload {} so the
  // response frame carries ONLY the messageId.
  client.send({ token: 't-empty' });
  const empty = await client.next(5000);
  expect(empty).not.toBeNull();
  expect(typeof empty.messageId).toBe('string');
  expect(Object.keys(empty)).toEqual(['messageId']);

  client.send({ token: 't-empty', a: null });
  const withNull = await client.next(5000);
  client.close();
  expect(withNull).not.toBeNull();
  expect(withNull.a).toBeNull();
  expect(typeof withNull.messageId).toBe('string');
}, 15000);

test('response ordering: rapid frames n=1..3 come back in send order', async () => {
  const client = new Client('/a');
  await client.open();
  client.send({ token: 't-ord', n: 1 });
  client.send({ token: 't-ord', n: 2 });
  client.send({ token: 't-ord', n: 3 });

  const got = [await client.next(5000), await client.next(5000), await client.next(5000)];
  client.close();

  for (const m of got) expect(m).not.toBeNull();
  expect(got.map((m) => m.echoed.n)).toEqual([1, 2, 3]);
}, 15000);

test('route hooks: onOpen x1, onMessage sees the deserialized event, onClose x1', async () => {
  const client = new Client('/hooks');
  await client.open();
  expect(await until(() => hookLog.opens === 1, 3000)).toBe(true);

  client.send({ token: 'hk', ping: true });
  const response = await client.next(5000);
  expect(response).not.toBeNull();
  expect(hookLog.messages.length).toBe(1);
  expect(hookLog.messages[0].messageSourceId).toBe('hk');
  expect(hookLog.messages[0].payload).toEqual({ ping: true });

  client.close();
  expect(await until(() => hookLog.closes === 1, 3000)).toBe(true);
  expect(hookLog.opens).toBe(1);
}, 20000);
