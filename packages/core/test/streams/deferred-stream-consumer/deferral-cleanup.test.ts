/**
 * streamAwaiter / DeferralTracker promise-map cleanup — GW8 (FASTIFY_GATEWAY_REVIEW.md).
 *
 * `dispatch` registers `stateTracker.promise(id)` (which arms a timeout) and then deletes
 * the entry — but ONLY on the success path. Every rejection leaks the `promises[id]`
 * entry forever:
 *   - a request TIMEOUT (verified: a gateway under timeout load grows unbounded), and
 *   - a `writeToStream` FAILURE (the entry AND its pending timer leak; the timer later
 *     rejects an unobserved promise → unhandled rejection).
 *
 * Contract under test (black-box): once `dispatch` settles for ANY reason, the tracker
 * retains no entry for that id. Per docs/specs/TESTING.md #10 this is written first and is
 * RED until the fix. Real Redis required (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource, streamAwaiter, StreamAwaiter } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const promiseCount = (a: { stateTracker: { promises: Record<string, unknown> } }) =>
  Object.keys(a.stateTracker.promises).length;

let readChannel: StreamingDataSource;
let writeChannel: StreamingDataSource;
beforeAll(async () => {
  readChannel = new StreamingDataSource(REDIS);
  writeChannel = new StreamingDataSource({ ...REDIS, controllable: false });
  await Promise.all([readChannel.connect(), writeChannel.connect()]);
});
afterAll(async () => {
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
});

test('factory dispatch: a TIMEOUT does not leak a promise-map entry', async () => {
  const key = `itest:deferral-to:${uniq()}`;
  // No responder is wired (no readResponseStream), so the dispatch must time out.
  const awaiter = streamAwaiter({ readChannel, writeChannel, incomingStream: `${key}-in`, outgoingStream: key, timeout: 200 });

  let threw = false;
  try { await awaiter.dispatch('{}', 'xfer' as any, ''); } catch { threw = true; }
  expect(threw).toBe(true);
  expect(promiseCount(awaiter)).toBe(0); // RED today: retains 1 forever

  await writeChannel.client.send('DEL', [key]).catch(() => {});
}, 15000);

test('factory dispatch: a writeToStream FAILURE does not leak a promise-map entry', async () => {
  const key = `itest:deferral-wf:${uniq()}`;
  // A write channel that is disconnected → writeToStream throws ("Failed XADD") deterministically.
  const deadWrite = new StreamingDataSource({ ...REDIS, controllable: false });
  await deadWrite.connect();
  await deadWrite.disconnect();

  const awaiter = streamAwaiter({ readChannel, writeChannel: deadWrite, incomingStream: `${key}-in`, outgoingStream: key, timeout: 200 });

  let threw = false;
  try { await awaiter.dispatch('{}', 'xfer' as any, ''); } catch { threw = true; }
  expect(threw).toBe(true);
  // RED today: the entry is retained AND a timer is left pending (which would later reject
  // an unobserved promise). After the fix the entry is gone and the timer is cleared.
  expect(promiseCount(awaiter)).toBe(0);
}, 15000);

test('factory dispatch: SUCCESS still cleans up (regression guard)', async () => {
  const key = `itest:deferral-ok:${uniq()}`;
  const incoming = `${key}-resp`;
  const awaiter = streamAwaiter({ readChannel, writeChannel, incomingStream: incoming, outgoingStream: key, timeout: 5000 });
  const dispose = await awaiter.readResponseStream();
  // Echo responder: read the request off `key`, write a response (same messageId) to `incoming`.
  const reader = new StreamingDataSource({ ...REDIS, controllable: false });
  await reader.connect();
  try {
    const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
    // Wait for the request to land, then respond with the same messageId.
    let req: any;
    for (let i = 0; i < 50 && !req; i++) {
      const reply = await reader.client.send('XRANGE', [key, '-', '+']) as Array<[string, string[]]>;
      if (reply?.length) {
        const kv = reply[0][1]; const f: Record<string, string> = {};
        for (let j = 0; j + 1 < kv.length; j += 2) f[kv[j]] = kv[j + 1];
        req = f;
      } else { await new Promise((r) => setTimeout(r, 20)); }
    }
    expect(req?.messageId).toBeTruthy();
    await writeChannel.writeToStream({
      outgoingStream: incoming, incomingStream: undefined, messageType: 'resp' as any,
      messageId: req.messageId, message: JSON.stringify({ ok: true }), sourceId: '',
    });
    const payload = await dispatched as any;
    expect(payload?.ok).toBe(true);
    expect(promiseCount(awaiter)).toBe(0); // passes today; must stay 0 after the fix
  } finally {
    (dispose as () => void)();
    await reader.disconnect();
    await readChannel.client.send('DEL', [key, incoming]).catch(() => {});
  }
}, 20000);

test('class StreamAwaiter dispatch: a TIMEOUT does not leak a promise-map entry', async () => {
  const key = `itest:deferral-cls:${uniq()}`;
  const awaiter = new StreamAwaiter({ readChannel, writeChannel, incomingStream: `${key}-in`, outgoingStream: key, timeout: 200 });

  let threw = false;
  try { await awaiter.dispatch('{}', 'xfer' as any, ''); } catch { threw = true; }
  expect(threw).toBe(true);
  expect(promiseCount(awaiter)).toBe(0); // RED today: retains 1 forever

  await writeChannel.client.send('DEL', [key]).catch(() => {});
}, 15000);
