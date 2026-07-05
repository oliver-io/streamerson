/**
 * Removing the LAST stream from a multi-stream reader (audit gap 10).
 *
 * PIN OF UNSTATED SEMANTICS: neither streamable.ts's doc comments nor the specs state
 * what a reader with an empty stream set does. The code path is deterministic:
 * `removeStreamId` empties `streamIdMap`; at the next loop top (≤ one blockingTimeout,
 * since UPDATE is passive) `blockingStreamBatchMap` throws
 * 'blockingStreamBatchMap: No streams to read from list of stream IDs', which the
 * catch rewraps as 'Failed XREAD [key=undefined, shard=undefined]' and rethrows; the
 * generator throws, so the Readable emits ONE 'error' and ends — fail-early, no hot
 * spin, no silent idle. This test asserts that observed behavior as the pinned
 * contract. If a future change makes an empty set idle-wait instead, this pin must be
 * revisited deliberately (it is a semantic choice, not a regression per se — but
 * silent idling would hide dead readers, so fail-early is the defensible pin).
 *
 * Reader construction mirrors dynamic-stream-set.test.ts: single-stream reader on A,
 * then `addStreamId(B)` transitions it to multi-stream fan-in mode; both keys are then
 * removed at runtime.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 100;

let writer: StreamingDataSource;
let reader: StreamingDataSource;
const keyA = `itest:rmlast:A:${uniq()}`;
const keyB = `itest:rmlast:B:${uniq()}`;

beforeAll(async () => {
  writer = new StreamingDataSource({ ...REDIS, controllable: false });
  reader = new StreamingDataSource(REDIS);
  await Promise.all([writer.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { await writer.client.send('DEL', [keyA, keyB]); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await writer.disconnect(); } catch { /* teardown */ }
});

const writeOne = (key: string, messageId: string) => writer.writeToStream({
  outgoingStream: key, incomingStream: undefined,
  messageType: 'data' as MessageType, messageId,
  message: JSON.stringify({}), sourceId: 'rmlast',
});

async function until(cond: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (cond()) return true; await sleep(step); }
  return cond();
}

describe('multi-stream reader with all streams removed (gap 10)', () => {
  test('removing the last stream fails early: one Readable error, no hot spin, no silent idle', async () => {
    const received: string[] = [];
    const errors: Error[] = [];
    let ended = false;
    const stream = reader.getReadStream({ stream: keyA, last: '0', blockingTimeout: BLOCK });
    stream.on('data', (ev: MappedStreamEvent) => received.push(ev.messageId));
    stream.on('error', (e: Error) => errors.push(e));
    stream.on('end', () => { ended = true; });

    // Establish the read loop FIRST (deliver an entry on A): the loop's persistent
    // UPDATE listener only exists once iteration has started, so an addStreamId
    // emitted before then would be missed (same ordering dynamic-stream-set.test.ts
    // uses via its established-reader fixture).
    await writeOne(keyA, 'a-0');
    // Generous setup windows: under a full-suite parallel run this file competes
    // with dozens of parked readers; 5s missed once at ~5.02s (event-driven, so
    // the wide bound costs nothing when healthy).
    expect(await until(() => received.includes('a-0'), 10000)).toBe(true);

    // Multi-stream mode: add B, prove both flow through the same reader.
    // NOTE: B's seed cursor is captured at the loop's first multi-stream read
    // (only-new, F1) — a B entry written BEFORE the fold-in is excluded by design.
    // Under full-suite load the fold-in can lag the first write, so converge by
    // retrying fresh B writes (each new id > the seed) until one is delivered.
    reader.addStreamId(keyB);
    await writeOne(keyA, 'a-1');
    let gotB = false;
    for (let i = 0; i < 30 && !gotB; i++) {
      await writeOne(keyB, `b-${i}`);
      gotB = await until(() => received.some((id) => id.startsWith('b-')), 500);
    }
    expect(gotB).toBe(true);
    expect(await until(() => received.includes('a-1'), 10000)).toBe(true);

    // Remove BOTH streams — the set is now empty.
    reader.removeStreamId(keyA);
    reader.removeStreamId(keyB);

    // PINNED: fail-early — a Readable 'error' within a couple of blocking cycles
    // (the in-flight block must finish, then the next cycle throws on the empty set).
    expect(await until(() => errors.length > 0 || ended, 4 * BLOCK + 8000)).toBe(true);
    expect(errors.length).toBe(1); // exactly one error — the loop ends, it does not spin
    expect(errors[0].message).toContain('Failed XREAD'); // the rewrapped empty-set throw

    // Entries written after the empty-set failure are not delivered (reader is dead).
    await writeOne(keyA, 'a-post');
    await sleep(3 * BLOCK);
    expect(received).not.toContain('a-post');
    expect(errors.length).toBe(1); // still exactly one — confirms no error-spin either
  }, 15000);
});
