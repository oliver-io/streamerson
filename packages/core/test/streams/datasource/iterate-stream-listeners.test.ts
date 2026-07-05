/**
 * CG-I1 regression. The `iterateStream` read loop must not register a fresh
 * keyEvents('update') listener on every blocking cycle — pre-fix, an idle
 * `getReadStream` consumer (e.g. the gateway response reader) accumulated ~10
 * listeners/sec and tripped Node's MaxListeners warning within ~1s. It must also
 * remove its listeners when iteration ends.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 * Run: bun test packages/core/test/streams/datasource/iterate-stream-listeners.test.ts
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const ds = new StreamingDataSource(REDIS);
const idleKey = `itest:cgi1:${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  try { await ds.abort(); } catch { /* */ }
  await sleep(50);
  try { await ds.client.send('DEL', [idleKey]); } catch { /* */ }
  try { await ds.disconnect(); } catch { /* */ }
});

test('an idle getReadStream consumer neither leaks nor strands keyEvents(update) listeners', async () => {
  await ds.connect();

  const stream = ds.getReadStream({ stream: idleKey, last: '$', blockingTimeout: 100 });
  const consume = (async () => {
    // Idle stream yields nothing; we just drive the generator.
    for await (const _ of stream as AsyncIterable<unknown>) { void _; }
  })();

  // ~12 blocking cycles. Pre-fix this exceeds the 10-listener warning threshold.
  await sleep(1200);
  const peak = ds.keyEvents.listenerCount('update');
  const peakCancel = ds.keyEvents.listenerCount('abort'); // KeyEvents.CANCEL = 'abort'

  await ds.abort();
  await Promise.race([consume, sleep(500)]);
  await sleep(50);
  const afterTeardown = ds.keyEvents.listenerCount('update');
  const afterTeardownCancel = ds.keyEvents.listenerCount('abort');

  expect(peak).toBeLessThanOrEqual(2);   // one persistent listener, not one-per-cycle
  expect(peakCancel).toBeLessThanOrEqual(2);
  expect(afterTeardown).toBe(0);          // cleaned up when iteration ended
  expect(afterTeardownCancel).toBe(0);    // the CANCEL ('abort') listener must be removed too
}, 15000);
