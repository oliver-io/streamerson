/**
 * Correlation-layer resilience to garbage on the response stream
 * (TESTING_ANALYSIS correlation gaps 6 and 7): a fieldless/garbled producer
 * entry must not wedge the reader, mis-resolve a healthy in-flight request, or
 * leak tracker state; a late/unknown-id response becomes an orphan pre-store
 * entry that self-deletes after `timeout * 2`. Real Redis, real reader loop —
 * garbage injected via raw XADD. Requires Redis (`bun run start:redis`).
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

async function until(fn: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (fn()) return true; await sleep(step); }
  return fn();
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

/** messageId of the first request on `reqKey` (to respond to it). */
async function firstMessageId(reqKey: string): Promise<string | undefined> {
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

test('garbage response entries neither wedge the reader nor mis-resolve a healthy request', async () => {
  const reqKey = `itest:malformed:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 5000 });
  const dispose = await awaiter.readResponseStream();

  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await firstMessageId(reqKey);
  expect(messageId).toBeTruthy();

  // Garbage ahead of the real response: a fieldless foreign entry, and a
  // streamerson-shaped entry with a broken JSON payload.
  await admin.client.send('XADD', [respKey, '*', 'foo', 'bar']);
  await admin.client.send('XADD', [respKey, '*',
    'messageId', 'garbled-1', 'messageType', 'resp', 'incomingStream', '',
    'messageHeaders', 'nil', 'messageProtocol', 'json', 'messageSourceId', '',
    'payload', '{broken',
  ]);
  // The real response, after the garbage — a wedged/killed reader would never deliver it.
  await writeChannel.writeToStream({ outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any, messageId: messageId!, message: JSON.stringify({ ok: true }), sourceId: '' });

  const payload = await dispatched as any;
  expect(payload?.ok).toBe(true); // resolved by ITS response, not by garbage

  // Tracker hygiene: no lingering deferrals or garbage-keyed entries.
  await until(() => Object.keys(awaiter.stateTracker.promises).length === 0, 2000);
  expect(Object.keys(awaiter.stateTracker.promises)).toEqual([]);

  await (dispose as () => Promise<void>)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);

test('an unknown-id (late/orphan) response pre-stores and self-deletes after timeout*2', async () => {
  const reqKey = `itest:orphan:${uniq()}`; const respKey = `${reqKey}-resp`;
  const { readChannel, writeChannel } = await freshChannels();
  // Small tracker timeout so the orphan's timeout*2 self-delete is observable fast.
  const awaiter = streamAwaiter({ logger: quiet, readChannel, writeChannel, incomingStream: respKey, outgoingStream: reqKey, timeout: 300 });
  const dispose = await awaiter.readResponseStream();

  await writeChannel.writeToStream({ outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any, messageId: 'ghost-1', message: JSON.stringify({ late: true }), sourceId: '' });

  // Orphan pre-store appears...
  expect(await until(() => 'ghost-1' in awaiter.stateTracker.promises, 2000)).toBe(true);
  // ...and self-deletes after ~timeout*2 (600ms), bounding growth under late responses.
  expect(await until(() => !('ghost-1' in awaiter.stateTracker.promises), 2000)).toBe(true);

  // The reader is still healthy afterwards: a normal dispatch round-trips.
  const dispatched = awaiter.dispatch('{}', 'xfer' as any, '');
  const messageId = await firstMessageId(reqKey);
  await writeChannel.writeToStream({ outgoingStream: respKey, incomingStream: undefined, messageType: 'resp' as any, messageId: messageId!, message: JSON.stringify({ ok: true }), sourceId: '' });
  expect(((await dispatched) as any)?.ok).toBe(true);

  await (dispose as () => Promise<void>)();
  await admin.client.send('DEL', [reqKey, respKey]).catch(() => {});
  try { await readChannel.disconnect(); } catch { /* */ }
  try { await writeChannel.disconnect(); } catch { /* */ }
}, 20000);
