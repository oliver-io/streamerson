/**
 * Response-reader edge coverage for streamAwaiter.readResponseStream:
 * (a) no history replay — pre-existing response entries never surface after arming;
 * (b) per-entry FRESH full timeout after an outage resume (resumeTimeouts re-arms
 *     each entry with its OWN timeoutMs, not a shared one);
 * (c) double-arm hazard — two readResponseStream() calls on one awaiter (unguarded).
 * Real Redis required (`bun run start:redis`). Harness matches self-heal-spec-gaps.test.ts.
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

async function until(pred: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

let admin: StreamingDataSource;
beforeAll(async () => { admin = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet }); await admin.connect(); });
afterAll(async () => { try { await admin.disconnect(); } catch { /* */ } });

async function freshChannels() {
  const readChannel = new StreamingDataSource({ ...REDIS, controllable: true, logger: quiet });
  const writeChannel = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet });
  await Promise.all([readChannel.connect(), writeChannel.connect()]);
  return { readChannel, writeChannel };
}

/** messageId of the Nth (0-based) request on `reqKey`. */
async function nthMessageId(reqKey: string, n: number): Promise<string | undefined> {
  for (let i = 0; i < 250; i++) {
    const reply = await admin.client.send('XRANGE', [reqKey, '-', '+']) as Array<[string, string[]]>;
    if (reply?.length > n) {
      const kv = reply[n][1]; const f: Record<string, string> = {};
      for (let j = 0; j + 1 < kv.length; j += 2) f[kv[j]] = kv[j + 1];
      if (f['messageId']) return f['messageId'];
    }
    await sleep(20);
  }
  return undefined;
}

function respond(writeChannel: StreamingDataSource, respKey: string, messageId: string, body: Record<string, unknown>) {
  return writeChannel.writeToStream({
    outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any,
    messageId, message: JSON.stringify(body), sourceId: '',
  });
}

test('(a) no history replay: response entries written before arming never surface', async () => {
  const reqKey = `itest:re-hist:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();

  // Three stale responses land BEFORE readResponseStream() is armed. The cursor
  // seeds from the stream tip, so none of these may ever be delivered.
  const staleIds = ['stale-1', 'stale-2', 'stale-3'];
  for (const id of staleIds) await respond(writeChannel, respKey, id, { stale: true });

  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 5000 });
  const dispose = await awaiter.readResponseStream();

  // Watch for any surfacing of the stale ids — as tracker orphans (interior sanity)
  // or as 'response' emissions (behavioral) — for the whole test window.
  const surfaced = new Set<string>();
  awaiter.stateTracker.on('response', (e: any) => { if (staleIds.includes(e.messageId)) surfaced.add(e.messageId); });
  const watcher = (async () => {
    for (let i = 0; i < 100; i++) {
      for (const id of staleIds) if (id in awaiter.stateTracker.promises) surfaced.add(id);
      await sleep(10);
    }
  })();

  // A normal dispatch still round-trips (the reader IS live, just not replaying history).
  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await nthMessageId(reqKey, 0);
  expect(messageId).toBeTruthy();
  await respond(writeChannel, respKey, messageId!, { ok: true });
  expect(((await dispatched) as any)?.ok).toBe(true);

  await watcher;
  expect([...surfaced]).toEqual([]); // none of the 3 pre-existing entries ever surfaced
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await (dispose as () => Promise<void>)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('(b) fresh full timeout after resume, per-entry: each frozen dispatch rejects at ITS OWN timeout from resume', async () => {
  const reqKey = `itest:re-thaw:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 1500, reconnect: { baseMs: 50, maxMs: 100 } });
  const dispose = await awaiter.readResponseStream();

  // Two in-flight deferrals: A with a 400ms per-call timeout, B with the 1500ms default.
  const rejectedAt: Record<string, number> = {};
  const dispatchedA = awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { timeout: 400 })
    .then(() => { throw new Error('A resolved unexpectedly'); }, (e: Error) => { rejectedAt['A'] = Date.now(); return e; });
  const dispatchedB = awaiter.dispatch('{}', 'xfer' as any, '')
    .then(() => { throw new Error('B resolved unexpectedly'); }, (e: Error) => { rejectedAt['B'] = Date.now(); return e; });
  await until(() => Object.keys(awaiter.stateTracker.promises).length === 2, 5000, 'both deferrals registered');

  // Outage: the blocking read errors, timers freeze; heal completes on its own
  // (real reconnect, short backoff). Never respond — both must time out post-resume.
  readChannel.client.close();
  await until(() => awaiter.stateTracker.suspended, 3000, 'healing to begin');
  await until(() => !awaiter.stateTracker.suspended, 5000, 'heal to complete');
  const resumedAt = Date.now();

  const [errA, errB] = await Promise.all([dispatchedA, dispatchedB]);
  expect(errA.message).toContain('timed out after 0.4 seconds');
  expect(errB.message).toContain('timed out after 1.5 seconds');

  // Coarse windows measured FROM RESUME (fresh full grace, per entry), plus ordering.
  const dA = rejectedAt['A'] - resumedAt;
  const dB = rejectedAt['B'] - resumedAt;
  expect(rejectedAt['A']).toBeLessThan(rejectedAt['B']); // 400ms entry fires first
  expect(dA).toBeGreaterThanOrEqual(200);  // not a stale pre-outage timer firing early
  expect(dA).toBeLessThan(1100);           // ...and well before B's 1500ms window
  expect(dB).toBeGreaterThanOrEqual(1100); // B got its own FULL 1500ms from resume
  expect(dB).toBeLessThan(3000);
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await (dispose as () => Promise<void>)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('(c) double readResponseStream on one awaiter: dispatch still resolves; duplicate delivery pins the unguarded hazard', async () => {
  const reqKey = `itest:re-double:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // BEHAVIOR PIN: nothing in readResponseStream guards against arming twice on the same
  // awaiter — each call arms its own reader on the same channel, so one response is
  // delivered once per reader. The first delivery resolves the deferral; the second
  // (deferral already deleted by dispatch's finally, or resolve is an idempotent no-op)
  // at worst pre-stores an orphan that self-deletes after timeout*2. This is a design
  // hazard, not a specified contract — this test pins today's benign outcome.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 600 });
  const dispose1 = await awaiter.readResponseStream();
  const dispose2 = await awaiter.readResponseStream();

  const deliveries: Record<string, number> = {};
  awaiter.stateTracker.on('response', (e: any) => { deliveries[e.messageId] = (deliveries[e.messageId] ?? 0) + 1; });

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await nthMessageId(reqKey, 0);
  expect(messageId).toBeTruthy();
  await respond(writeChannel, respKey, messageId!, { ok: true });
  expect(((await dispatched) as any)?.ok).toBe(true); // the dispatch resolves regardless

  // Pin the duplicate delivery and its consequence: any orphan entry left by the second
  // reader self-deletes (timeout*2 = 1200ms) and the map returns to empty.
  await sleep(300); // let the second reader's delivery (if any) land
  expect(deliveries[messageId!]).toBeGreaterThanOrEqual(1);
  expect(deliveries[messageId!]).toBeLessThanOrEqual(2);
  await until(() => Object.keys(awaiter.stateTracker.promises).length === 0, 3000, 'orphan (if any) to self-delete');

  // Both disposers resolve.
  await (dispose1 as () => Promise<void>)();
  await (dispose2 as () => Promise<void>)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);
