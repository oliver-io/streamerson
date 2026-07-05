/**
 * Dispatch-path edge coverage for the correlation layer (streamAwaiter.dispatch):
 * correlation under out-of-order response storms, duplicate responses, abort
 * semantics (pre-aborted, abort/resolve races, post-resolution abort), the
 * `timeout: 0` per-call override, outgoingStream-vs-override precedence, and the
 * inert `concurrency` option. Real Redis required (`bun run start:redis`).
 * Style/harness matches self-heal-spec-gaps.test.ts / malformed-response.test.ts.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource, streamAwaiter } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
};
const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: StreamingDataSource;
beforeAll(async () => { admin = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet }); await admin.connect(); });
afterAll(async () => { try { await admin.disconnect(); } catch { /* */ } });

async function freshChannels() {
  const readChannel = new StreamingDataSource({ ...REDIS, controllable: true, logger: quiet });
  const writeChannel = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet });
  await Promise.all([readChannel.connect(), writeChannel.connect()]);
  return { readChannel, writeChannel };
}

// Bounded event-driven wait on a predicate (no bare sleeps as race arbiters).
async function until(pred: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** All request entries currently on `reqKey`, in arrival order, as {messageId, payload}. */
async function requestEntries(reqKey: string): Promise<Array<{ messageId: string; payload: string }>> {
  const reply = await admin.client.send('XRANGE', [reqKey, '-', '+']) as Array<[string, string[]]>;
  const out: Array<{ messageId: string; payload: string }> = [];
  for (const [, kv] of reply ?? []) {
    const f: Record<string, string> = {};
    for (let j = 0; j + 1 < kv.length; j += 2) f[kv[j]] = kv[j + 1];
    if (f['messageId']) out.push({ messageId: f['messageId'], payload: f['payload'] ?? '' });
  }
  return out;
}

async function xlen(key: string): Promise<number> {
  return Number(await admin.client.send('XLEN', [key]));
}

function respond(writeChannel: StreamingDataSource, respKey: string, messageId: string, body: Record<string, unknown>) {
  return writeChannel.writeToStream({
    outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any,
    messageId, message: JSON.stringify(body), sourceId: '',
  });
}

async function teardown(dispose: unknown, readChannel: StreamingDataSource, writeChannel: StreamingDataSource, ...keys: string[]) {
  await (dispose as () => Promise<void>)();
  await admin.client.send('DEL', keys).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}

test('(a) correlation storm: 100 concurrent dispatches each resolve with their own payload despite reverse-order responses', async () => {
  const reqKey = `itest:de-storm:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 15000 });
  const dispose = await awaiter.readResponseStream();

  const N = 100;
  const dispatched: Promise<any>[] = [];
  for (let i = 0; i < N; i++) {
    dispatched.push(awaiter.dispatch(JSON.stringify({ n: i }), 'xfer' as any, ''));
  }

  // Real responder: raw-read the request stream until all N have arrived, then
  // XADD each response in REVERSE order of arrival, echoing the request's `n`.
  let arrived: Array<{ messageId: string; payload: string }> = [];
  const t0 = Date.now();
  while (arrived.length < N) {
    if (Date.now() - t0 > 10000) throw new Error('timed out waiting for all requests');
    await sleep(20);
    arrived = await requestEntries(reqKey);
  }
  for (const { messageId, payload } of [...arrived].reverse()) {
    const { n } = JSON.parse(payload);
    await respond(writeChannel, respKey, messageId, { echo: n });
  }

  const results = await Promise.all(dispatched);
  for (let i = 0; i < N; i++) expect(results[i]?.echo).toBe(i); // exactly its own payload
  await until(() => Object.keys(awaiter.stateTracker.promises).length === 0, 2000, 'tracker map to empty');

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 30000);

test('(b) duplicate response for one id: first resolves, second becomes a self-deleting orphan, awaiter stays healthy', async () => {
  const reqKey = `itest:de-dup:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // Small timeout so the orphan's timeout*2 self-delete window (800ms) is observable fast.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 400 });
  const dispose = await awaiter.readResponseStream();

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  let entries: Array<{ messageId: string }> = [];
  const t0 = Date.now();
  while (entries.length < 1) {
    if (Date.now() - t0 > 5000) throw new Error('timed out waiting for request');
    await sleep(20);
    entries = await requestEntries(reqKey);
  }
  const id = entries[0].messageId;

  await respond(writeChannel, respKey, id, { first: true });
  const payload = await dispatched as any;
  expect(payload?.first).toBe(true);

  // Duplicate: same messageId again. The deferral is gone (deleted in dispatch's
  // finally), so the reader's delivery pre-stores an orphan — no crash.
  await respond(writeChannel, respKey, id, { second: true });
  await until(() => id in awaiter.stateTracker.promises, 2000, 'orphan pre-store');
  // Orphan self-deletes within ~2*timeout.
  await until(() => !(id in awaiter.stateTracker.promises), 2000, 'orphan self-delete');

  // A subsequent dispatch still round-trips.
  const again = awaiter.dispatch('{}', 'xfer' as any, '');
  let all: Array<{ messageId: string }> = [];
  const t1 = Date.now();
  while (all.length < 2) {
    if (Date.now() - t1 > 5000) throw new Error('timed out waiting for second request');
    await sleep(20);
    all = await requestEntries(reqKey);
  }
  await respond(writeChannel, respKey, all[1].messageId, { ok: true });
  expect(((await again) as any)?.ok).toBe(true);
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 20000);

test('(c) pre-aborted signal: dispatch throws CANCELLED, enqueues nothing, and leaves the tracker empty', async () => {
  const reqKey = `itest:de-preabort:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 2000 });
  const dispose = await awaiter.readResponseStream();

  const lenBefore = await xlen(reqKey);
  const ac = new AbortController();
  ac.abort();

  let err: Error | undefined;
  try { await awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { signal: ac.signal }); }
  catch (e) { err = e as Error; }
  expect(err?.message).toContain('CANCELLED');

  // Nothing enqueued for a gone client, and no deferral registered.
  expect(await xlen(reqKey)).toBe(lenBefore);
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 20000);

test('(d) abort-at-resolution race: every iteration settles (payload XOR CANCELLED); post-resolution abort is a no-op', async () => {
  const reqKey = `itest:de-race:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // timeout 1000 bounds the orphan self-delete window (2s): when the abort wins the race,
  // the just-late response parks an orphan by design (covered in malformed-response.test.ts),
  // so per-iteration we assert no REAL deferral remains (orphans carry no timeoutMs) and
  // check full map emptiness once at the end.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 1000 });
  const dispose = await awaiter.readResponseStream();
  const realCount = () => Object.values(awaiter.stateTracker.promises).filter((e: any) => e.timeoutMs !== undefined).length;

  for (let i = 0; i < 15; i++) {
    const ac = new AbortController();
    const dispatched = awaiter.dispatch(JSON.stringify({ i }), 'xfer' as any, '', undefined, undefined, { signal: ac.signal });
    let entries = await requestEntries(reqKey);
    const t0 = Date.now();
    while (entries.length < i + 1) {
      if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for request ${i}`);
      await sleep(10);
      entries = await requestEntries(reqKey);
    }
    // Respond and abort in the same macrotask: a genuine resolve/abort race.
    void respond(writeChannel, respKey, entries[i].messageId, { echo: i });
    ac.abort();

    // Must settle — payload XOR CANCELLED — never hang (Promise.race cap).
    const outcome = await Promise.race([
      dispatched.then(
        (p: any) => ({ kind: 'payload' as const, p }),
        (e: Error) => ({ kind: 'error' as const, e }),
      ),
      sleep(8000).then(() => ({ kind: 'hang' as const })),
    ]);
    expect(outcome.kind).not.toBe('hang');
    if (outcome.kind === 'payload') expect((outcome as any).p?.echo).toBe(i);
    else expect((outcome as any).e.message).toContain('CANCELLED');
    await until(() => realCount() === 0, 2000, `no real deferral after iter ${i}`);
  }

  // Aborting AFTER resolution is a no-op: no throw, no map entry.
  const ac = new AbortController();
  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { signal: ac.signal });
  let entries = await requestEntries(reqKey);
  const t1 = Date.now();
  while (entries.length < 16) {
    if (Date.now() - t1 > 5000) throw new Error('timed out waiting for final request');
    await sleep(10);
    entries = await requestEntries(reqKey);
  }
  await respond(writeChannel, respKey, entries[15].messageId, { ok: true });
  expect(((await dispatched) as any)?.ok).toBe(true);
  ac.abort(); // resolved already — must not throw or resurrect a deferral
  await sleep(50);
  expect(realCount()).toBe(0);
  // All abort-race orphans self-delete within 2×timeout; map fully empty at the end.
  await until(() => Object.keys(awaiter.stateTracker.promises).length === 0, 4000, 'map fully empty');

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 60000);

test('(e) per-call timeout: 0 is honored (not falsy-defaulted): rejects near-immediately with "after 0 seconds"', async () => {
  const reqKey = `itest:de-tzero:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // Large awaiter default so a falsy-defaulted 0 would be unmistakable (60s vs ~0ms).
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000 });
  const dispose = await awaiter.readResponseStream();

  // `promise(id, 0)` computes `timeoutMs ?? this.timeout`; ?? preserves 0 (unlike ||),
  // so a 0ms timer arms and fires on the next tick. No responder — must reject.
  const t0 = Date.now();
  let err: Error | undefined;
  try { await awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { timeout: 0 }); }
  catch (e) { err = e as Error; }
  const elapsed = Date.now() - t0;
  expect(err?.message).toContain('timed out after 0 seconds');
  expect(elapsed).toBeLessThan(1000); // near-immediate, nowhere near the 60s default
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 20000);

test('(f) stream-target precedence: configured outgoingStream wins over the dispatch "override" parameter', async () => {
  const reqKeyA = `itest:de-prec-A:${uniq()}`; const respKey = `${reqKeyA}-resp`;
  const reqKeyB = `itest:de-prec-B:${uniq()}`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKeyA, timeout: 5000 });
  const dispose = await awaiter.readResponseStream();

  // BEHAVIOR PIN, deliberate: dispatch computes `outgoingStream ?? outgoingStreamOverride`,
  // so the configured stream (A) always wins and the parameter named "Override" can never
  // override — it is only a FALLBACK for awaiters constructed without an outgoingStream.
  // Call-site audit (grep outgoingStreamOverride across packages/): no caller ever passes
  // it — gateway-fastify passes `undefined`, state-machine/consumer don't use it. With zero
  // live callers this is a misleading parameter NAME, not a broken contract, so this test
  // pins the observed precedence rather than going RED on the name's implication.
  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '', undefined, reqKeyB);
  const t0 = Date.now();
  while ((await xlen(reqKeyA)) < 1) {
    if (Date.now() - t0 > 5000) throw new Error('timed out waiting for request on A');
    await sleep(10);
  }
  expect(await xlen(reqKeyA)).toBe(1); // configured target received the request
  expect(await xlen(reqKeyB)).toBe(0); // "override" target was ignored entirely

  const [entry] = await requestEntries(reqKeyA);
  await respond(writeChannel, respKey, entry.messageId, { ok: true });
  expect(((await dispatched) as any)?.ok).toBe(true);

  await teardown(dispose, readChannel, writeChannel, reqKeyA, reqKeyB, respKey);
}, 20000);

test('(g) `concurrency` option is inert: 20 parallel dispatches all hit the stream before any response exists', async () => {
  const reqKey = `itest:de-conc:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // BEHAVIOR PIN: `concurrency` is accepted by streamAwaiterOptions but read by nothing in
  // stream-awaiter.ts — dead config. This test pins the absence of gating (all 20 requests
  // are XADDed while the response stream is still empty) until the option is either
  // implemented or removed; if gating ever appears, this test flags the contract change.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 10000, concurrency: 1 });
  const dispose = await awaiter.readResponseStream();

  const N = 20;
  const dispatched = Array.from({ length: N }, (_, i) => awaiter.dispatch(JSON.stringify({ i }), 'xfer' as any, ''));

  // With concurrency:1 actually enforced, at most 1 request could be pending un-responded.
  const t0 = Date.now();
  while ((await xlen(reqKey)) < N) {
    if (Date.now() - t0 > 10000) throw new Error('timed out waiting for all requests');
    await sleep(10);
  }
  expect(await xlen(reqKey)).toBe(N);
  expect(await xlen(respKey)).toBe(0); // zero responses written yet — hence zero gating

  const entries = await requestEntries(reqKey);
  for (const { messageId, payload } of entries) {
    await respond(writeChannel, respKey, messageId, { echo: JSON.parse(payload).i });
  }
  const results = await Promise.all(dispatched);
  results.forEach((r: any, i: number) => expect(r?.echo).toBe(i));

  await teardown(dispose, readChannel, writeChannel, reqKey, respKey);
}, 30000);
