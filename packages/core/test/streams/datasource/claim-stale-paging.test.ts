/**
 * `claimStale` (XAUTOCLAIM) pagination + idle-reset exclusion (audit gap 14).
 *
 * Signature under test (streamable.ts): claimStale(stream, groupId, consumer, minIdle,
 * cursor='0-0', count=100) → { cursor, entries } where cursor === '0-0' when the PEL
 * scan wraps, and each XAUTOCLAIM atomically resets the claimed entries' idle time —
 * the documented basis for a concurrent reclaimer's idle filter excluding them.
 *
 * Setup: entries are abandoned to a phantom consumer via a raw XREADGROUP (delivered,
 * never acked, consumer never returns).
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import type { MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ds: StreamingDataSource;
const keys: string[] = [];

beforeAll(async () => {
  ds = new StreamingDataSource(REDIS);
  await ds.connect();
});
afterAll(async () => {
  try { if (keys.length) await ds.client.send('DEL', keys); } catch { /* teardown */ }
  try { await ds.disconnect(); } catch { /* teardown */ }
});

/** Write n entries, deliver them all to a phantom consumer, return their stream ids. */
async function abandonN(key: string, group: string, n: number): Promise<string[]> {
  keys.push(key);
  await ds.createConsumerGroup({ stream: key, groupId: group, cursor: '0' });
  for (let i = 0; i < n; i++) {
    await ds.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: `stale-${i}`,
      message: JSON.stringify({ i }), sourceId: 'claim-itest',
    });
  }
  // Raw group read into the phantom's PEL — delivered, never acked, never resumed.
  const delivered = await ds.readGroupEntries(key, group, 'phantom', '>', 100, n);
  expect(delivered.length).toBe(n);
  return delivered.map((e) => e.streamMessageId!);
}

describe('claimStale pagination and idle-reset exclusion (gap 14)', () => {
  test('small-count pages walk the whole PEL: every abandoned entry claimed exactly once, cursor wraps to 0-0', async () => {
    const key = `itest:claimpage:${uniq()}`;
    const group = 'g-page';
    const abandoned = await abandonN(key, group, 25);

    const claimed: string[] = [];
    let cursor = '0-0';
    let pages = 0;
    do {
      const res = await ds.claimStale(key, group, 'reaper', 0, cursor, 7); // page size 7 over 25 entries
      cursor = res.cursor;
      claimed.push(...res.entries.map((e) => e.streamMessageId!));
      pages++;
      expect(pages).toBeLessThanOrEqual(10); // scan terminates; no cursor livelock
    } while (cursor !== '0-0');

    // Exactly once across pages: same multiset as the abandoned ids, no dup, no miss.
    expect(claimed.length).toBe(25);
    expect(new Set(claimed).size).toBe(25);
    expect([...claimed].sort()).toEqual([...abandoned].sort());
    // And ownership actually moved: the whole PEL now belongs to the reaper.
    const pending = await ds.pendingDetails(key, group, 50);
    expect(pending.every((p) => p.consumer === 'reaper')).toBe(true);
    expect(pending.length).toBe(25);
  }, 15000);

  test('claiming resets idle: an immediate concurrent claimStale with the same minIdle cannot re-claim the page', async () => {
    const key = `itest:claimidle:${uniq()}`;
    const group = 'g-idle';
    const MIN_IDLE = 200;
    await abandonN(key, group, 25);

    // Bounded event-ish wait: all entries idle >= MIN_IDLE (idle is server-side state;
    // poll pendingDetails rather than sleeping blind).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const p = await ds.pendingDetails(key, group, 50);
      if (p.length === 25 && p.every((e) => e.idle >= MIN_IDLE)) break;
      await sleep(25);
    }

    // Claimer 1 takes one page — XAUTOCLAIM resets those entries' idle to ~0.
    const page1 = await ds.claimStale(key, group, 'claimer-1', MIN_IDLE, '0-0', 10);
    expect(page1.entries.length).toBe(10);
    const page1Ids = new Set(page1.entries.map((e) => e.streamMessageId!));

    // Claimer 2, immediately, same minIdle, full scan: must see NONE of page 1 —
    // only the still-idle remainder. Disjointness is the contract.
    const seen2: string[] = [];
    let cursor = '0-0';
    do {
      const res = await ds.claimStale(key, group, 'claimer-2', MIN_IDLE, cursor, 10);
      cursor = res.cursor;
      seen2.push(...res.entries.map((e) => e.streamMessageId!));
    } while (cursor !== '0-0');

    expect(seen2.some((id) => page1Ids.has(id))).toBe(false); // disjoint from page 1
    expect(seen2.length).toBe(15);                            // exactly the remainder
    // Ownership reflects the split.
    const pending = await ds.pendingDetails(key, group, 50);
    expect(pending.filter((p) => p.consumer === 'claimer-1').length).toBe(10);
    expect(pending.filter((p) => p.consumer === 'claimer-2').length).toBe(15);
  }, 15000);
});
