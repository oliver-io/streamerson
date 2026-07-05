/**
 * Ordering + cursor-semantics integration tests (the linearizable-log promise,
 * docs CONSISTENCY.md; cursor contract documented on `getReadStream` in
 * streamable.ts). Exercises the real read loop against live Redis:
 *   (a) '0' drains a backlog in exact write order across multiple batch cycles;
 *   (b) default '$' delivers only post-subscription entries;
 *   (c) an explicit `<id>` cursor is strictly-after (no re-delivery of id k);
 *   (d) two concurrent writers observe one total order consistent with each
 *       writer's own order and with monotonic streamMessageIds;
 *   (e) duplicate messageIds are NOT deduped at the datasource layer.
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
let writer2: StreamingDataSource;
let reader: StreamingDataSource;
const keys: string[] = [];
const key = (tag: string) => { const k = `itest:ordering:${tag}:${uniq()}`; keys.push(k); return k; };

beforeAll(async () => {
  writer = new StreamingDataSource({ ...REDIS, controllable: false });
  writer2 = new StreamingDataSource({ ...REDIS, controllable: false });
  reader = new StreamingDataSource(REDIS);
  await Promise.all([writer.connect(), writer2.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { if (keys.length) await writer.client.send('DEL', keys); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await writer.disconnect(); } catch { /* teardown */ }
  try { await writer2.disconnect(); } catch { /* teardown */ }
});

const writeOne = (ds: StreamingDataSource, k: string, messageId: string) => ds.writeToStream({
  outgoingStream: k, incomingStream: undefined,
  messageType: 'data' as MessageType, messageId,
  message: JSON.stringify({}), sourceId: 'ordering',
}) as Promise<string>;

async function until(cond: () => boolean, ms: number, step = 15) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (cond()) return true; await sleep(step); }
  return cond();
}

/** True iff `sub` appears in `seq` in order (not necessarily contiguously). */
function isSubsequence(sub: string[], seq: string[]) {
  let i = 0;
  for (const s of seq) if (s === sub[i]) i++;
  return i === sub.length;
}

describe('ordering and cursor semantics', () => {
  test("(a) '0' cursor drains a 25-entry backlog in exact write order across batch cycles", async () => {
    const k = key('drain');
    const expected: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `m-${String(i).padStart(2, '0')}`;
      expected.push(id);
      await writeOne(writer, k, id);
    }

    // requestedBatchSize 10 over 25 entries forces at least 3 read cycles.
    const stream = reader.getReadStream({ stream: k, last: '0', requestedBatchSize: 10, blockingTimeout: BLOCK });
    const got: string[] = [];
    stream.on('data', (ev: MappedStreamEvent) => got.push(ev.messageId));
    expect(await until(() => got.length >= 25, 5000)).toBe(true);
    stream.destroy();

    expect(got).toEqual(expected); // full-sequence equality: exact write order
  }, 10000);

  test("(b) default '$' delivers only entries written after the reader is live", async () => {
    const k = key('dollar');
    for (let i = 0; i < 5; i++) await writeOne(writer, k, `pre-${i}`);

    // No `last` → '$'. The tip resolves at the FIRST read, so establish the
    // reader (a couple of blocking cycles) before writing the new entries.
    const stream = reader.getReadStream({ stream: k, blockingTimeout: BLOCK });
    const got: string[] = [];
    stream.on('data', (ev: MappedStreamEvent) => got.push(ev.messageId));
    await sleep(3 * BLOCK); // reader parked at the tip

    for (let i = 0; i < 3; i++) await writeOne(writer, k, `new-${i}`);
    expect(await until(() => got.length >= 3, 5000)).toBe(true);
    // Negative-stability window: nothing further (esp. no backlog) trickles in.
    await sleep(3 * BLOCK);
    stream.destroy();

    expect(got).toEqual(['new-0', 'new-1', 'new-2']); // exactly the 3 new, none of the 5 pre-existing
  }, 10000);

  test('(c) explicit <id> cursor is strictly-after: entry k is never re-delivered', async () => {
    const k = key('after');
    const streamIds: string[] = [];
    for (let i = 0; i < 6; i++) streamIds.push(await writeOne(writer, k, `m-${i}`));

    const cursorAt = 3; // read strictly after entry k = m-3
    const stream = reader.getReadStream({ stream: k, last: streamIds[cursorAt], blockingTimeout: BLOCK });
    const got: string[] = [];
    stream.on('data', (ev: MappedStreamEvent) => got.push(ev.messageId));
    expect(await until(() => got.length >= 2, 5000)).toBe(true);
    await sleep(2 * BLOCK); // stability: nothing at or before the cursor arrives late
    stream.destroy();

    expect(got).toEqual(['m-4', 'm-5']); // starts at k+1; m-3 (and earlier) never re-delivered
  }, 10000);

  test("(d) two concurrent writers: a '0' reader observes one total order consistent with each writer's order", async () => {
    const k = key('duel');
    const aIds = Array.from({ length: 20 }, (_, i) => `A-${String(i).padStart(2, '0')}`);
    const bIds = Array.from({ length: 20 }, (_, i) => `B-${String(i).padStart(2, '0')}`);
    // Alternating awaits interleave the two connections' XADDs.
    for (let i = 0; i < 20; i++) {
      await writeOne(writer, k, aIds[i]);
      await writeOne(writer2, k, bIds[i]);
    }

    const stream = reader.getReadStream({ stream: k, last: '0', blockingTimeout: BLOCK });
    const got: Array<{ id: string; sid: string }> = [];
    stream.on('data', (ev: MappedStreamEvent) => got.push({ id: ev.messageId, sid: ev.streamMessageId! }));
    expect(await until(() => got.length >= 40, 5000)).toBe(true);
    stream.destroy();

    expect(got.length).toBe(40);
    const order = got.map((g) => g.id);
    // Total order respects each writer's per-writer order.
    expect(isSubsequence(aIds, order)).toBe(true);
    expect(isSubsequence(bIds, order)).toBe(true);
    // And streamMessageIds are strictly monotonic (Redis assigns a total order).
    const [toMs, toSeq] = [(s: string) => Number(s.split('-')[0]), (s: string) => Number(s.split('-')[1])];
    for (let i = 1; i < got.length; i++) {
      const prev = got[i - 1].sid, cur = got[i].sid;
      const later = toMs(cur) > toMs(prev) || (toMs(cur) === toMs(prev) && toSeq(cur) > toSeq(prev));
      expect(later).toBe(true);
    }
  }, 10000);

  test('(e) duplicate messageId: the datasource yields BOTH entries (no dedupe at this layer)', async () => {
    // Contract boundary pin: the datasource is a faithful log reader. Two stream
    // entries carrying the same application messageId are two entries — dedupe /
    // correlation-by-messageId is owned upstream (the correlation layer), not here.
    const k = key('dupe');
    await writeOne(writer, k, 'same-id');
    await writeOne(writer, k, 'same-id');

    const stream = reader.getReadStream({ stream: k, last: '0', blockingTimeout: BLOCK });
    const got: MappedStreamEvent[] = [];
    stream.on('data', (ev: MappedStreamEvent) => got.push(ev));
    expect(await until(() => got.length >= 2, 5000)).toBe(true);
    stream.destroy();

    expect(got.length).toBe(2);
    expect(got[0].messageId).toBe('same-id');
    expect(got[1].messageId).toBe('same-id');
    expect(got[0].streamMessageId).not.toBe(got[1].streamMessageId);
  }, 10000);
});
