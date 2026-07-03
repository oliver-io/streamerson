/**
 * Gateway response-reader self-heal — Q1 (GW9) + Q9 (GW15).
 * Spec & concurrency model: docs/specs/GATEWAY_READER_SELF_HEAL.md (§10 = this plan).
 *
 * Contracts under test (black-box where possible), written first per docs/specs/TESTING.md
 * #10 — RED until the self-heal exists. Real Redis required (`bun run start:redis`).
 *
 *  1. cursor-resume: a response written during a read outage is delivered after reconnect
 *     (re-arm from lastCursor, NOT '$' — proves Q9 + the backlog flush).
 *  2. freeze: an in-flight request does not spuriously time out while the reader is down,
 *     and resolves on recovery (proves §5 suspend/resume).
 *  4. give-up: with maxAttempts set and a permanent outage, pending requests reject after the
 *     cap (mapped to 503 at the gateway), not before.
 *  5. client-abort releases a frozen/pending wait (AbortSignal — R8).
 *  6. dispose during healing tears down cleanly with no post-dispose reconnect (R4/§7).
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

// Pull the messageId of the first request written to `reqKey` (so a test can respond to it).
async function firstMessageId(admin: StreamingDataSource, reqKey: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const reply = await admin.client.send('XRANGE', [reqKey, '-', '+']) as Array<[string, string[]]>;
    if (reply?.length) {
      const kv = reply[0][1]; const f: Record<string, string> = {};
      for (let j = 0; j + 1 < kv.length; j += 2) f[kv[j]] = kv[j + 1];
      if (f['messageId']) return f['messageId'];
    }
    await sleep(20);
  }
  return undefined;
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

test('1. cursor-resume: a response written during an outage is delivered after reconnect', async () => {
  const reqKey = `itest:sh1:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 1200, reconnect: { baseMs: 50, maxMs: 200 } });
  const dispose = await awaiter.readResponseStream();

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await firstMessageId(admin, reqKey);
  expect(messageId).toBeTruthy();

  // OUTAGE: drop the read connection WITHOUT disconnect() (closing stays false → the reader
  // errors). Then write the response *during* the outage; cursor-resume must read it.
  readChannel.client.close();
  await sleep(40);
  await writeChannel.writeToStream({ outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any, messageId: messageId!, message: JSON.stringify({ ok: true }), sourceId: '' });

  const payload = await dispatched as any; // RED: no self-heal → reader dead → times out
  expect(payload?.ok).toBe(true);

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('2. freeze: an in-flight request does not time out while the reader is down', async () => {
  const reqKey = `itest:sh2:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 200, reconnect: { baseMs: 40, maxMs: 80 } });
  const dispose = await awaiter.readResponseStream();

  // Hold the outage open: reconnect fails until the test allows it.
  let allowReconnect = false;
  const realReconnect = (readChannel as any).reconnect.bind(readChannel);
  spyOn(readChannel as any, 'reconnect').mockImplementation(async () => { if (!allowReconnect) throw new Error('still down'); return realReconnect(); });

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await firstMessageId(admin, reqKey);
  expect(messageId).toBeTruthy();

  readChannel.client.close();   // outage begins

  // Past the 200ms dispatch timeout, the request must still be pending (frozen), not rejected.
  const state = await Promise.race([
    dispatched.then(() => 'settled', () => 'settled'),
    sleep(500).then(() => 'pending'),
  ]);
  expect(state).toBe('pending');

  // Allow recovery, deliver the response, and confirm it resolves.
  allowReconnect = true;
  await sleep(60);
  await writeChannel.writeToStream({ outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any, messageId: messageId!, message: JSON.stringify({ ok: true }), sourceId: '' });
  const payload = await dispatched as any;
  expect(payload?.ok).toBe(true);

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('4. give-up: pending requests reject after maxAttempts on a permanent outage', async () => {
  const reqKey = `itest:sh4:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000, reconnect: { baseMs: 20, maxMs: 40, maxAttempts: 3 } });
  const dispose = await awaiter.readResponseStream();

  // Permanent outage: reconnect always fails.
  spyOn(readChannel as any, 'reconnect').mockImplementation(async () => { throw new Error('down'); });

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  await firstMessageId(admin, reqKey);
  readChannel.client.close();

  let rejected = false;
  try { await dispatched; } catch { rejected = true; }
  expect(rejected).toBe(true);   // RED: no give-up → frozen/never rejects within window (times out at 60s)

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('5. client-abort releases a pending wait', async () => {
  const reqKey = `itest:sh5:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000 });
  const dispose = await awaiter.readResponseStream();

  // No responder is wired; the request would pend until the (60s) timeout. The client aborts.
  const ac = new AbortController();
  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { signal: ac.signal });
  // Observe the outcome immediately (as the gateway handler does via `await`), so the abort's
  // rejection is always handled — no transient unhandled-rejection window.
  const outcome = dispatched.then(() => 'resolved' as const, () => 'rejected' as const);
  const messageId = await firstMessageId(admin, reqKey);
  expect(messageId).toBeTruthy();
  expect(Object.keys(awaiter.stateTracker.promises)).toContain(messageId);

  ac.abort();
  await sleep(50);
  // entry released by the abort (fast RED: pre-impl dispatch ignores opts → still 1)
  expect(Object.keys(awaiter.stateTracker.promises).length).toBe(0);
  expect(await outcome).toBe('rejected');

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('per-call timeout override (Q6): dispatch(opts.timeout) overrides the awaiter default', async () => {
  const reqKey = `itest:sh-to:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // Awaiter default is huge; a per-call 200ms override (a per-route timeout at the gateway)
  // must govern instead — reject ~fast, not after 60s.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000 });
  const dispose = await awaiter.readResponseStream();

  const t0 = Date.now();
  let rejected = false;
  try { await awaiter.dispatch('{}', 'xfer' as any, '', undefined, undefined, { timeout: 200 }); } catch { rejected = true; }
  const dt = Date.now() - t0;
  expect(rejected).toBe(true);
  expect(dt).toBeLessThan(2000); // ~200ms, far under the 60s default

  await (dispose as () => unknown)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('6. dispose during healing tears down with no post-dispose reconnect', async () => {
  const reqKey = `itest:sh6:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // Long backoff so we can dispose mid-heal deterministically.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 60000, reconnect: { baseMs: 1500, maxMs: 1500 } });
  const dispose = await awaiter.readResponseStream();

  let reconnects = 0;
  spyOn(readChannel as any, 'reconnect').mockImplementation(async () => { reconnects++; throw new Error('still down'); });

  readChannel.client.close();     // outage → enter healing → suspend → backoff(1500ms)
  await sleep(100);               // we're now parked in backoff, before the first reconnect

  await (dispose as () => unknown)();   // dispose mid-heal: must interrupt backoff and not reconnect
  const afterDispose = reconnects;
  await sleep(300);
  expect(reconnects).toBe(afterDispose); // no reconnect fired after dispose

  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);
