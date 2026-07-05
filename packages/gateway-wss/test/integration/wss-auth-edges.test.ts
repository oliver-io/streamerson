/**
 * WSS gateway auth + failure-path edge cases. Two harnesses:
 *
 *  - IN-PROCESS gateway (wss-roundtrip style) for the non-throwing cases:
 *    header-gated auth, plain-GET upgrade failure, zero-subscriber drop.
 *  - SUBPROCESS gateway (fixtures/wss-throwing-fixture.ts, same pattern as the
 *    malformed-frames/redis-failure suites) for the THROWING authenticate and
 *    onMessage cases. In-process these throws contaminate bun:test (the runner's
 *    error hook captures server-handler throws and fails whichever test happens
 *    to be running), so survival is asserted against the REAL process. Verdicts
 *    (bun 1.3.14): a throwing `authenticate` is caught by Bun.serve's fetch error
 *    handling (500 response, process survives — GREEN); a throwing `onMessage`
 *    is an unhandled rejection inside the async websocket `message` handler and
 *    KILLS the gateway process (exit 1) — the same defect class as the malformed
 *    frame crash, so that test is EXPECTED RED against the intended
 *    survive-and-serve contract (see wss-malformed-frames.test.ts).
 *
 * Real Redis, real WebSocket clients, core-primitives echo workers, no mocks.
 * Requires Redis (`bun run start:redis`).
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

const PORT = 20100 + Math.floor(Math.random() * 200);
const stamp = Date.now();
const topicAuth = new Topic({ namespace: 'wss-itest', topic: `auth-gated-${stamp}` });
const topicOpen = new Topic({ namespace: 'wss-itest', topic: `auth-open-${stamp}` });
const topicLazy = new Topic({ namespace: 'wss-itest', topic: `auth-lazy-${stamp}` });
// Subprocess fixture topics.
const topicFixOpen = new Topic({ namespace: 'wss-itest', topic: `auth-fix-open-${stamp}` });
const topicFixThrow = new Topic({ namespace: 'wss-itest', topic: `auth-fix-throw-${stamp}` });
const topicFixHook = new Topic({ namespace: 'wss-itest', topic: `auth-fix-hook-${stamp}` });
const allTopics = [topicAuth, topicOpen, topicLazy, topicFixOpen, topicFixThrow, topicFixHook];

const LAZY_DELAY_MS = 700;

let wss: WebSocketServer;
let admin: StreamingDataSource;
const workers: StreamingDataSource[] = [];
let fixture: { proc: ReturnType<typeof Bun.spawn>; port: number };

async function spawnWorker(topic: Topic, delayMs = 0) {
  const reader = new StreamingDataSource(REDIS);
  const writer = new StreamingDataSource(REDIS);
  await Promise.all([reader.connect(), writer.connect()]);
  workers.push(reader, writer);
  reader.getReadStream({ stream: topic.consumerKey(), last: '0' }).on('data', (event: MappedStreamEvent) => {
    void (async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await writer.writeToStream({
        outgoingStream: topic.producerKey(),
        incomingStream: topic.consumerKey(),
        messageType: 'RESPONSE' as MessageType,
        messageId: event.messageId,
        message: JSON.stringify({ echoed: event.payload }),
        sourceId: event.messageSourceId,
      });
    })();
  });
}

class Client {
  ws: WebSocket;
  private queue: any[] = [];
  private waiters: Array<(m: any) => void> = [];

  constructor(path: string, opts?: { headers?: Record<string, string>; port?: number }) {
    const url = `ws://localhost:${opts?.port ?? PORT}${path}`;
    // Bun's WebSocket accepts an options bag with custom handshake headers
    // (probe-verified: header-gated upgrade succeeds with it, fails without).
    this.ws = opts?.headers ? new WebSocket(url, { headers: opts.headers } as any) : new WebSocket(url);
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
      // Swallow the ErrorEvent (reject with a plain Error) so bun:test doesn't
      // surface the socket failure as an unhandled error between tests.
      this.ws.onerror = () => { /* close always follows */ };
      this.ws.onclose = (e) => reject(new Error(`handshake failed (close code ${e.code})`));
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

  closed(ms: number): Promise<boolean> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.ws.addEventListener('close', () => { clearTimeout(timer); resolve(true); });
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** Liveness probe: a fresh round-trip through an always-authenticated route. */
async function assertOpenRouteRoundTrips(token: string, port?: number) {
  const client = new Client('/open', { port });
  await client.open();
  client.send({ token, alive: true });
  const response = await client.next(5000);
  client.close();
  expect(response).not.toBeNull();
  expect(response.echoed).toEqual({ alive: true });
}

beforeAll(async () => {
  admin = new StreamingDataSource(REDIS);
  await admin.connect();

  await spawnWorker(topicAuth);
  await spawnWorker(topicOpen);
  await spawnWorker(topicLazy, LAZY_DELAY_MS);
  await spawnWorker(topicFixOpen); // serves the subprocess's /open liveness probe
  // No worker for topicFixThrow (never reachable) or topicFixHook (its stream
  // must stay untouched so the skipped-write assertion reads a raw XLEN).

  wss = new WebSocketServer({ port: PORT });
  await wss.streamRoute('/auth', 'itest', topicAuth, {
    authenticate: (req) => req.headers.get('x-auth') === 'yes',
  });
  await wss.streamRoute('/open', 'itest', topicOpen, { authenticate: () => true });
  await wss.streamRoute('/lazy', 'itest', topicLazy, { authenticate: () => true });
  await wss.listen();

  // Subprocess gateway hosting the throwing routes (see header comment).
  const fixturePort = PORT + 200;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', `${import.meta.dir}/fixtures/wss-throwing-fixture.ts`],
    env: {
      ...process.env,
      WSS_FIXTURE_PORT: String(fixturePort),
      WSS_FIXTURE_TOPIC: topicFixOpen.topic,
      WSS_FIXTURE_TOPIC_THROW: topicFixThrow.topic,
      WSS_FIXTURE_TOPIC_HOOK: topicFixHook.topic,
    },
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
  fixture = { proc, port: fixturePort };
});

afterAll(async () => {
  try { wss.stop(); } catch { /* ignore */ }
  try { fixture?.proc.kill(); } catch { /* ignore */ }
  for (const w of workers) { try { w.abort(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 150));
  for (const t of allTopics) {
    try { await admin.client.send('DEL', [t.consumerKey()]); } catch { /* ignore */ }
    try { await admin.client.send('DEL', [t.producerKey()]); } catch { /* ignore */ }
  }
  for (const w of workers) { try { await w.disconnect(); } catch { /* ignore */ } }
  try { await admin.disconnect(); } catch { /* ignore */ }
});

/** Race the fixture's exit against a 404 liveness probe (malformed-frames style). */
async function assertFixtureAlive(context: string) {
  const exited = fixture.proc.exited.then((code) => ({ exited: true as const, code }));
  const probe = (async () => {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`http://localhost:${fixture.port}/nope`);
    return { exited: false as const, status: res.status };
  })();
  const outcome = await Promise.race([exited, probe]);
  if (outcome.exited) {
    const stderr = await new Response(fixture.proc.stderr).text();
    expect().fail(`${context}: gateway process died (exit ${outcome.code}). stderr tail: ${stderr.slice(-400)}`);
  } else {
    expect(outcome.status).toBe(404);
  }
}

test('header-gated auth: missing header is rejected, present header upgrades and round-trips', async () => {
  // Negative half over plain fetch with upgrade headers: authenticate runs before
  // the upgrade attempt, so the missing x-auth yields 401.
  const denied = await fetch(`http://localhost:${PORT}/auth`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
  expect(denied.status).toBe(401);

  // Negative half as a real WS client: the handshake must fail.
  const rejected = new Client('/auth');
  await expect(rejected.open()).rejects.toBeDefined();

  // Positive half: Bun WebSocket handshake headers carry the credential.
  const accepted = new Client('/auth', { headers: { 'x-auth': 'yes' } });
  await accepted.open();
  // Retry the send: the route's loopback reader tails from '$' resolved at its
  // FIRST blocking read, so under full-suite load a response written before the
  // reader parks is dropped (join-window semantics). A re-sent frame converges.
  let response: any = null;
  for (let attempt = 0; attempt < 8 && response === null; attempt++) {
    accepted.send({ token: 't-auth', secret: 1 });
    response = await accepted.next(1000);
  }
  accepted.close();
  expect(response).not.toBeNull();
  expect(response.echoed).toEqual({ secret: 1 });
}, 15000);

test('throwing authenticate: handshake fails, server survives and keeps serving', async () => {
  // Pinned: Bun.serve catches the fetch-handler throw and answers 500; the
  // process survives (asserted against a REAL subprocess, not just in-process).
  const plain = await fetch(`http://localhost:${fixture.port}/throwauth`);
  expect(plain.status).toBe(500);

  const client = new Client('/throwauth', { port: fixture.port });
  await expect(client.open()).rejects.toBeDefined();

  await assertFixtureAlive('throwing authenticate');
  await assertOpenRouteRoundTrips('t-survive-auth', fixture.port);
}, 20000);

test('plain GET without upgrade headers to a valid path is 500 "WebSocket upgrade failed"', async () => {
  const response = await fetch(`http://localhost:${PORT}/open`);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('WebSocket upgrade failed');
}, 15000);

test('throwing onMessage hook: server survives and the stream write is skipped', async () => {
  // EXPECTED RED (product defect, proven vs harness): the hook throw rejects the
  // async websocket `message` handler in wssapi.ts with nothing to catch it, and
  // the REAL gateway subprocess exits 1 (stderr shows the boom-onmessage stack at
  // wssapi.ts message()) — the same unhandled-rejection crash class the
  // malformed-frames suite pins. This test asserts the INTENDED contract:
  // survive, keep serving, and (structurally, since `await onMessage` precedes
  // `outgoingStream.write`) skip the stream write — itself a hazard candidate:
  // the frame is silently dropped, no error frame, no dead-letter.
  const client = new Client('/hookthrow', { port: fixture.port });
  await client.open();
  client.send({ token: 't-hook', x: 1 });
  await new Promise((r) => setTimeout(r, 500));

  await assertFixtureAlive('throwing onMessage');
  expect(Number(await admin.client.send('XLEN', [topicFixHook.consumerKey()]))).toBe(0);
  expect(await client.next(500)).toBeNull();
  client.close();

  await assertOpenRouteRoundTrips('t-survive-hook', fixture.port);
}, 20000);

test('response for a token with zero subscribers is dropped, not queued (lazy re-subscribe semantics)', async () => {
  // c1 sends and disconnects before the slow worker (LAZY_DELAY_MS) answers: the
  // gateway's response publish finds subscriberCount('t-lazy') === 0 and drops it.
  const c1 = new Client('/lazy');
  await c1.open();
  c1.send({ token: 't-lazy', n: 1 });
  c1.close();
  expect(await c1.closed(3000)).toBe(true);

  // A NEW client with the same token that has NOT sent yet is not subscribed —
  // subscription only happens on a socket's first send — so the late response for
  // n:1 (and anything else) must never reach it: drop, not queue.
  const c2 = new Client('/lazy');
  await c2.open();
  expect(await c2.next(LAZY_DELAY_MS + 800)).toBeNull();

  // After c2 sends once it is subscribed and receives exactly its own response.
  c2.send({ token: 't-lazy', n: 2 });
  const own = await c2.next(5000);
  expect(own).not.toBeNull();
  expect(own.echoed).toEqual({ n: 2 });
  expect(await c2.next(500)).toBeNull();
  c2.close();

  // Server healthy throughout.
  await assertOpenRouteRoundTrips('t-survive-lazy');
}, 20000);
