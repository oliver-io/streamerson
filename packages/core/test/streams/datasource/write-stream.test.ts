/**
 * getWriteStream contract — error surfacing, payload validation, no lossy clone.
 *
 * Covers (STREAM_READER_DEFECTS.md):
 *   F2 — a write failure (e.g. XADD WRONGTYPE) must surface as an `'error'` event /
 *        `callback(err)`, NOT a silent pipeline stall + unhandled rejection.
 *   F4 — falsy-but-valid payloads (`0`, `''`, `false`) must be written, not dropped.
 *   F7 — a non-JSON payload (bigint) must surface as an error rather than silently
 *        stalling (the symptom of the per-message JSON deep-clone).
 *
 * Per docs/specs/TESTING.md #10 these are written first and are RED until the fix.
 * Real Redis required (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import type { Writable } from 'stream';
import { StreamingDataSource } from '../../../src';
import type { MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Capture unhandled rejections so a write error that (today) escapes the stream does not
// crash the runner — and so we can assert it does NOT escape once fixed.
const rejections: string[] = [];
const onRej = (e: unknown) => rejections.push(String((e as Error)?.message ?? e));

let ds: StreamingDataSource;
beforeAll(async () => { process.on('unhandledRejection', onRej); ds = new StreamingDataSource(REDIS); await ds.connect(); });
afterAll(async () => { process.off('unhandledRejection', onRej); try { await ds.disconnect(); } catch { /* */ } });

/**
 * Write one chunk; resolve with how it settled (callback err, 'error' event, or neither).
 * A failed write surfaces BOTH via the write callback AND an 'error' event; the listener
 * is kept attached so the 'error' event is always handled (an unhandled 'error' throws).
 */
function writeAndSettle(w: Writable, chunk: unknown, ms = 1500): Promise<'ok' | 'error' | 'stalled'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: 'ok' | 'error' | 'stalled') => { if (!done) { done = true; resolve(o); } };
    w.on('error', () => finish('error'));
    w.write(chunk as never, (e?: Error | null) => finish(e ? 'error' : 'ok'));
    setTimeout(() => finish('stalled'), ms);
  });
}

async function readBack(key: string): Promise<Array<Record<string, string>>> {
  const reply = (await ds.client.send('XRANGE', [key, '-', '+'])) as Array<[string, string[]]>;
  return (reply ?? []).map(([, kv]) => { const f: Record<string, string> = {}; for (let i = 0; i + 1 < kv.length; i += 2) f[kv[i]] = kv[i + 1]; return f; });
}

describe('getWriteStream contract', () => {
  test('F2: an XADD failure surfaces as an error, not a silent stall', async () => {
    const key = `itest:wstream:wrongtype:${uniq()}`;
    await ds.set({ key }, 'not-a-stream'); // occupy the key as a string → XADD WRONGTYPE
    const w = ds.getWriteStream({ stream: key });
    const outcome = await writeAndSettle(w, { messageId: 'x-1', messageType: 'data' as MessageType, payload: { a: 1 } });
    expect(outcome).toBe('error');
    await ds.client.send('DEL', [key]);
  }, 15000);

  test('F4: falsy-but-valid payloads (0, "", false) are written, not dropped', async () => {
    const key = `itest:wstream:falsy:${uniq()}`;
    const w = ds.getWriteStream({ stream: key });
    await writeAndSettle(w, { messageId: 'zero', messageType: 'data' as MessageType, payload: 0 });
    await writeAndSettle(w, { messageId: 'emptystr', messageType: 'data' as MessageType, payload: '' });
    await writeAndSettle(w, { messageId: 'falseval', messageType: 'data' as MessageType, payload: false });
    await sleep(100);
    const ids = (await readBack(key)).map((f) => f['messageId']).sort();
    expect(ids).toEqual(['emptystr', 'falseval', 'zero']);
    await ds.client.send('DEL', [key]);
  }, 15000);

  test('drop semantics preserved: missing messageId or null payload is dropped without error', async () => {
    const key = `itest:wstream:drop:${uniq()}`;
    const w = ds.getWriteStream({ stream: key });
    expect(await writeAndSettle(w, { messageId: '', messageType: 'data' as MessageType, payload: { a: 1 } })).toBe('ok');
    expect(await writeAndSettle(w, { messageId: 'nullpay', messageType: 'data' as MessageType, payload: null })).toBe('ok');
    await sleep(100);
    expect((await readBack(key)).length).toBe(0);
    await ds.client.send('DEL', [key]);
  }, 15000);

  test('F7: a non-JSON (bigint) payload surfaces as an error, not a silent stall', async () => {
    const key = `itest:wstream:bigint:${uniq()}`;
    const w = ds.getWriteStream({ stream: key });
    const outcome = await writeAndSettle(w, { messageId: 'big', messageType: 'data' as MessageType, payload: { n: 10n } });
    expect(outcome).toBe('error');
    expect((await readBack(key)).length).toBe(0);
    await ds.client.send('DEL', [key]);
  }, 15000);

  test('round-trip: a written event decodes back equivalently (incl. falsy fields)', async () => {
    const key = `itest:wstream:rt:${uniq()}`;
    const w = ds.getWriteStream({ stream: key });
    const payload = { a: 1, nested: { b: [1, 2, 'x'] }, flag: false, zero: 0 };
    await writeAndSettle(w, { messageId: 'rt', messageType: 'data' as MessageType, messageSourceId: 'src', payload });
    await sleep(100);
    const back = (await readBack(key))[0];
    expect(back['messageId']).toBe('rt');
    expect(back['messageSourceId']).toBe('src');
    expect(JSON.parse(back['payload'])).toEqual(payload);
    await ds.client.send('DEL', [key]);
  }, 15000);

  test('F2: write errors do not escape as unhandled rejections', async () => {
    await sleep(150); // let any rejection from the error-path tests settle
    expect(rejections).toEqual([]);
  }, 15000);
});
