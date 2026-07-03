/**
 * GW9 (FASTIFY_GATEWAY_REVIEW.md) — `readResponseStream` opens the producer stream as a
 * `Readable` and attaches only an `.on('data')` router. It attaches NO `'error'` listener.
 * If a live read throws non-intentionally (a Redis drop mid-`XREAD`, where `closing` is
 * false → `blockingStreamBatchMap` re-throws), the `Readable` emits `'error'` with no
 * listener — an unhandled `'error'` event, which is process-fatal in Node/Bun. The
 * gateway's response channel is its lifeline; a transient Redis blip should not take down
 * the whole HTTP server.
 *
 * The crash occurs IFF no `'error'` listener is attached, and reproducing a real mid-read
 * drop deterministically is nondeterministic (why the review marked this `[code]`). So the
 * guard asserts the unambiguous mechanism: arming the reader MUST attach an `'error'`
 * listener to the response stream (so an emitted error is consumed, not fatal), and the
 * disposer MUST remove it (no listener leak across re-arms). Written first per
 * docs/specs/TESTING.md #10; RED until the listener exists. Real Redis required.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Readable } from 'stream';
import { StreamingDataSource, streamAwaiter, StreamAwaiter } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
};
const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let readChannel: StreamingDataSource;
let writeChannel: StreamingDataSource;
beforeAll(async () => {
  readChannel = new StreamingDataSource({ ...REDIS, controllable: true, logger: quiet });
  writeChannel = new StreamingDataSource({ ...REDIS, controllable: false, logger: quiet });
  await Promise.all([readChannel.connect(), writeChannel.connect()]);
});
afterAll(async () => {
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
});

// Capture the Readable that `readResponseStream` opens, by spying on getReadStream.
function spyReadStream(channel: StreamingDataSource): { restore: () => void; get: () => Readable | undefined } {
  const orig = channel.getReadStream.bind(channel);
  let captured: Readable | undefined;
  (channel as any).getReadStream = (opts: any) => { captured = orig(opts) as unknown as Readable; return captured; };
  return { restore: () => { (channel as any).getReadStream = orig; }, get: () => captured };
}

test('GW9 (factory): readResponseStream attaches an error listener; disposer removes it', async () => {
  const key = `itest:gw9-f:${uniq()}`;
  const spy = spyReadStream(readChannel);
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: `${key}-in`, outgoingStream: key, timeout: 1000 });

  const dispose = await awaiter.readResponseStream();
  const stream = spy.get()!;
  expect(stream).toBeDefined();
  // RED today: 0 (no listener → an emitted 'error' is unhandled → process-fatal).
  expect(stream.listenerCount('error')).toBeGreaterThanOrEqual(1);

  (dispose as () => void)();
  // No listener leak across re-arms.
  expect(stream.listenerCount('error')).toBe(0);
  spy.restore();
}, 15000);

test('GW9 (class): readResponseStream attaches an error listener; disposer removes it', async () => {
  const key = `itest:gw9-c:${uniq()}`;
  const spy = spyReadStream(readChannel);
  const awaiter = new StreamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: `${key}-in`, outgoingStream: key, timeout: 1000 });

  const dispose = await awaiter.readResponseStream();
  const stream = spy.get()!;
  expect(stream).toBeDefined();
  expect(stream.listenerCount('error')).toBeGreaterThanOrEqual(1);

  (dispose as () => void)();
  expect(stream.listenerCount('error')).toBe(0);
  spy.restore();
}, 15000);
