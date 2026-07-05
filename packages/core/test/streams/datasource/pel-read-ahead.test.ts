/**
 * PEL read-ahead characterization (audit gap 7 / F6).
 *
 * Consumer-group mode `getReadStream` is documented (streamable.ts, getReadStream doc
 * comment) as an INTERNAL building block whose objectMode Readable "pulls entries into
 * the PEL ahead of consumption". This test pins the SIZE of that state-loss surface:
 * with a paused consumer, how many delivered-unacked entries strand in the PEL, and
 * that every one of them is recoverable via `pendingDetails()` (the receipt-spec basis:
 * delivered-but-unconsumed entries are pending, not lost).
 *
 * Bound derivation (EMPIRICAL, Bun 1.3.14): Bun's Readable.from(..., { objectMode })
 * reports readableHighWaterMark = 1 (Node's would be 16). With `requestedBatchSize: 1`
 * each generator pull is one XREADGROUP COUNT 1, i.e. one PEL entry per pull; a parked
 * consumer pre-buffers up to HWM plus one in-flight pull. Observed (probe, stable
 * across samples at 0.5s/1s/2s/3s): 1 entry stranded of a 40-entry burst when parked
 * before any consume, 2 when one item was consumed then stalled — i.e. exactly
 * (HWM + in-flight) × batch. Pinned bound: (HWM + 1) × batch, computed from the live
 * stream's readableHighWaterMark so the pin stays honest if the runtime's HWM changes
 * (under Node semantics the same formula yields 17).
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

const BLOCK = 100;
const BATCH = 1;
const BURST = 40; // far exceeds the read-ahead bound, exposing unbounded pull-ahead if it regressed

let admin: StreamingDataSource;
let reader: StreamingDataSource;
const key = `itest:pelra:${uniq()}`;
const group = 'g-pelra';
const member = 'm1';

beforeAll(async () => {
  admin = new StreamingDataSource({ ...REDIS, controllable: false });
  reader = new StreamingDataSource(REDIS);
  await Promise.all([admin.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { await admin.client.send('DEL', [key]); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await admin.disconnect(); } catch { /* teardown */ }
});

/** Bounded poll: resolves as soon as `cond` is true. */
async function until(cond: () => Promise<boolean> | boolean, ms: number, step = 25) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (await cond()) return true; await sleep(step); }
  return await cond();
}

describe('consumer-group getReadStream — PEL read-ahead bound (gap 7 / F6)', () => {
  test('a paused consumer strands at most ~HWM×batch entries in the PEL, all recoverable via pendingDetails', async () => {
    await admin.createConsumerGroup({ stream: key, groupId: group, cursor: '0' });
    // Burst BEFORE the reader starts, so read-ahead alone determines PEL growth.
    for (let i = 0; i < BURST; i++) {
      await admin.writeToStream({
        outgoingStream: key, incomingStream: undefined,
        messageType: 'data' as MessageType, messageId: `burst-${i}`,
        message: JSON.stringify({ i }), sourceId: 'pelra-itest',
      });
    }

    const stream = reader.getReadStream({
      stream: key, requestedBatchSize: BATCH, blockingTimeout: BLOCK,
      consumerGroupInstanceConfig: { groupId: group, groupMemberId: member },
    });
    // (HWM + 1 in-flight) × batch — see header. Bun 1.3.14: (1 + 1) × 1 = 2.
    const READ_AHEAD_BOUND = (stream.readableHighWaterMark + 1) * BATCH;
    // Parked consumer: a 'readable' listener kicks off the internal read(0) fill loop
    // (buffer fills toward HWM) but we never call read(), so nothing is consumed —
    // only the Readable's read-ahead pulls entries (into the PEL). A 'data' listener
    // + immediate pause() can leave the buffer entirely unfilled (resume is cancelled
    // before the first _read), which would test nothing.
    stream.on('readable', () => { /* never read() — stay parked */ });
    stream.pause();

    // Wait until the PEL stabilizes: two consecutive equal XPENDING samples ~3 blocking
    // cycles apart (event-ish bounded wait; XPENDING has no push notification).
    const pelCount = async () => (await admin.pendingDetails(key, group, BURST + 10, member)).length;
    let prev = -1;
    await until(async () => {
      const now = await pelCount();
      const stable = now > 0 && now === prev;
      prev = now;
      if (!stable) await sleep(3 * BLOCK);
      return stable;
    }, 8000, 10);

    const pending = await admin.pendingDetails(key, group, BURST + 10, member);
    // Bounded read-ahead: NOT the whole burst, and within the derived envelope.
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(BURST);
    expect(pending.length).toBeLessThanOrEqual(READ_AHEAD_BOUND);

    // Recoverability: every stranded (delivered-unacked) entry is exactly the first
    // pending.length entries of the stream — ids match XRANGE head 1:1, nothing lost.
    const range = await admin.client.send('XRANGE', [key, '-', '+', 'COUNT', String(pending.length)]) as Array<[string, string[]]>;
    expect(pending.map((p) => p.id)).toEqual(range.map(([id]) => id));

    await reader.abort();
    await sleep(150);
  }, 20000);
});
