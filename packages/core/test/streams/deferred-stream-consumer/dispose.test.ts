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

  await sleep(120); // let the read loop attach its keyEvents listeners
  const attached = readChannel.keyEvents.listenerCount('update');
  expect(attached).toBeGreaterThan(0);

  (dispose as () => void)();
  await sleep(200); // let the destroyed generator run its finally (bounded by blockingTimeout)
  expect(readChannel.keyEvents.listenerCount('update')).toBe(0);

  await readChannel.client.send('DEL', [key]).catch(() => {});
}, 15000);
