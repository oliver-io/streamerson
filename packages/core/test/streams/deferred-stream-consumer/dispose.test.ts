/**
 * streamAwaiter response-reader disposal — STREAM_READER_DEFECTS.md F8.
 *
 * `readResponseStream()` starts a getReadStream that previously ran until process exit
 * with no teardown handle. It must return a disposer that stops the reader and removes
 * its `keyEvents` listeners. Per docs/specs/TESTING.md #10 this is written first and is
 * RED until the fix (today the method resolves to `undefined`). Real Redis required.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource, streamAwaiter } from '../../../src';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
/** Poll until `fn()` holds or `ms` elapses (event-driven wait, no fixed sleep). */
async function until(fn: () => boolean, ms: number, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await sleep(step);
}

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

test('readResponseStream returns a disposer that tears the response reader down', async () => {
  const key = `itest:awaiter:${uniq()}`;
  const awaiter = streamAwaiter({ readChannel, writeChannel, incomingStream: key, outgoingStream: `${key}-out` });

  const dispose = await awaiter.readResponseStream();
  expect(typeof dispose).toBe('function');

  // Wait (bounded) for the read loop to attach its keyEvents listeners.
  await until(() => readChannel.keyEvents.listenerCount('update') > 0, 2000);
  const attached = readChannel.keyEvents.listenerCount('update');
  expect(attached).toBeGreaterThan(0);

  (dispose as () => void)();
  // Wait (bounded by blockingTimeout) for the destroyed generator's finally to detach them.
  await until(() => readChannel.keyEvents.listenerCount('update') === 0, 5000);
  expect(readChannel.keyEvents.listenerCount('update')).toBe(0);

  await readChannel.client.send('DEL', [key]).catch(() => {});
}, 15000);
