/**
 * Gateway response-reader self-heal — spec-gap coverage (punch-list P2-12).
 * Spec: docs/specs/GATEWAY_READER_SELF_HEAL.md. Companion to self-heal.test.ts, which
 * deliberately skips spec §10 test 3; this file adds:
 *
 *  3. no-duplicate-delivery across a re-arm (R2/R5): an already-resolved response is never
 *     re-delivered after an outage + heal (exclusive re-arm from lastCursor; no orphan entry).
 *  R6. dispatch DURING an outage: a request written mid-outage (writeChannel is independent)
 *     is frozen like in-flight ones — it must not hit its per-call timeout while the reader
 *     is down, and resolves once healed and responded.
 *  R10. attempts reset on real delivery: with maxAttempts:1, outage→heal→deliver twice in a
 *     row; if `attempts` were NOT reset by the first successful delivery, the second outage
 *     would give up immediately (cancelAll 'reader unavailable') instead of healing.
 *
 * Real Redis required (`bun run start:redis`). Failure injection matches self-heal.test.ts:
 * `readChannel.client.close()` without disconnect() so the blocking read genuinely errors.
 */
import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { StreamingDataSource, streamAwaiter } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
};
const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until `reqKey` holds at least `count` requests; return their messageIds in order.
async function messageIds(admin: StreamingDataSource, reqKey: string, count: number): Promise<string[]> {
  for (let i = 0; i < 150; i++) {
    const reply = await admin.client.send('XRANGE', [reqKey, '-', '+']) as Array<[string, string[]]>;
    if (reply?.length >= count) {
      const out: string[] = [];
      for (const [, kv] of reply) {
        const f: Record<string, string> = {};
        for (let j = 0; j + 1 < kv.length; j += 2) f[kv[j]] = kv[j + 1];
        if (f['messageId']) out.push(f['messageId']);
      }
      if (out.length >= count) return out;
    }
    await sleep(20);
  }
  return [];
}

// Bounded event-driven wait on a predicate (no bare sleeps as race arbiters).
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

function respond(writeChannel: StreamingDataSource, respKey: string, messageId: string, body: Record<string, unknown>) {
  return writeChannel.writeToStream({
    outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any,
    messageId, message: JSON.stringify(body), sourceId: '',
  });
}

test('3. no duplicate delivery: a resolved response is not re-delivered across a re-arm (R2/R5)', async () => {
  const reqKey = `itest:shg3:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 5000, reconnect: { baseMs: 100, maxMs: 200 } });
  const dispose = await awaiter.readResponseStream();

  // Count deliveries per messageId to catch any re-emit behaviorally.
  const deliveries: Record<string, number> = {};
  awaiter.stateTracker.on('response', (e: any) => { deliveries[e.messageId] = (deliveries[e.messageId] ?? 0) + 1; });

  // Dispatch A, respond, and let it fully resolve BEFORE the outage.
  const dispatchedA = awaiter.dispatch('{}', 'xfer' as any, '');
  const [idA] = await messageIds(admin, reqKey, 1);
  expect(idA).toBeTruthy();
  await respond(writeChannel, respKey, idA, { which: 'A' });
  const payloadA = await dispatchedA as any;
  expect(payloadA?.which).toBe('A');
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  // OUTAGE + self-heal: re-arm must be exclusive of A's delivered entry.
  readChannel.client.close();
  await until(() => awaiter.stateTracker.suspended, 3000, 'healing to begin');
  await until(() => !awaiter.stateTracker.suspended, 5000, 'heal to complete');

  // Dispatch B post-heal and respond; B must resolve normally.
  const dispatchedB = awaiter.dispatch('{}', 'xfer' as any, '');
  const ids = await messageIds(admin, reqKey, 2);
  const idB = ids[1];
  expect(idB).toBeTruthy();
  await respond(writeChannel, respKey, idB, { which: 'B' });
  const payloadB = await dispatchedB as any;
  expect(payloadB?.which).toBe('B');

  // Stability window for the NEGATIVE assert: no late re-delivery of A.
  await sleep(300);
  expect(deliveries[idA]).toBe(1);            // A delivered exactly once, never re-emitted
  expect(deliveries[idB]).toBe(1);
  // Interior sanity: no orphan entry re-created for A (a re-delivery would land in the
  // tracker's else-branch and park an orphan for timeout*2); map returns to size 0.
  expect(awaiter.stateTracker.promises[idA]).toBeUndefined();
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('R6: a dispatch made DURING the outage is frozen and resolves after recovery', async () => {
  const reqKey = `itest:shg6:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000, reconnect: { baseMs: 40, maxMs: 80 } });
  const dispose = await awaiter.readResponseStream();

  // Hold the outage open until the test allows recovery (same gate as self-heal.test.ts #2).
  let allowReconnect = false;
  const realReconnect = (readChannel as any).reconnect.bind(readChannel);
  spyOn(readChannel as any, 'reconnect').mockImplementation(async () => { if (!allowReconnect) throw new Error('still down'); return realReconnect(); });

  readChannel.client.close();   // outage begins with NOTHING in flight
  await until(() => awaiter.stateTracker.suspended, 3000, 'healing to begin');

  // Dispatch C mid-outage with a short per-call timeout. The writeChannel is independent
  // (R6), so the write succeeds; the deferral registers while suspended → no timer armed.
  const dispatchedC = awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { timeout: 800 });
  const [idC] = await messageIds(admin, reqKey, 1);
  expect(idC).toBeTruthy();

  // Hold the outage past C's 800ms timeout: frozen, so it must still be pending.
  const state = await Promise.race([
    dispatchedC.then(() => 'settled', () => 'settled'),
    sleep(1200).then(() => 'pending'),
  ]);
  expect(state).toBe('pending');

  // Recover, respond, resolve.
  allowReconnect = true;
  await until(() => !awaiter.stateTracker.suspended, 5000, 'heal to complete');
  await respond(writeChannel, respKey, idC, { which: 'C' });
  const payload = await dispatchedC as any;
  expect(payload?.which).toBe('C');

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('R10: attempts reset on real delivery — two outage/heal/deliver cycles with maxAttempts:1 never give up', async () => {
  const reqKey = `itest:shg10:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // maxAttempts:1 is the discriminator: the give-up check runs BEFORE each attempt, so if a
  // successful delivery did NOT reset `attempts` back to 0, the second outage would see
  // attempts(1) >= maxAttempts(1) and cancelAll('reader unavailable') without ever retrying.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 10000, reconnect: { baseMs: 40, maxMs: 80, maxAttempts: 1 } });
  const dispose = await awaiter.readResponseStream();

  for (let cycle = 1; cycle <= 2; cycle++) {
    const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
    const ids = await messageIds(admin, reqKey, cycle);
    const id = ids[cycle - 1];
    expect(id).toBeTruthy();

    // Outage N: close() guarantees the armed blocking read errors → heal loop runs; the
    // response written now can only arrive via a successful re-arm (cursor-resume backlog).
    readChannel.client.close();
    await sleep(40); // let the read error surface before the response lands (matches self-heal #1)
    await respond(writeChannel, respKey, id, { cycle });

    // If the attempt budget were exhausted, this rejects with CANCELLED: reader unavailable.
    const payload = await dispatched as any;
    expect(payload?.cycle).toBe(cycle);   // real delivery — resets `attempts` (R10)
    expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);
  }

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);
