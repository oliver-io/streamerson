/**
 * Only-new cursor seeding for a runtime-added stream (audit gap 11 — F1's other half).
 *
 * Contract (streamable.ts, blockingStreamBatchMap multi-stream arm): a stream added at
 * runtime is seeded ONCE at its current tip via `lastGeneratedId` — stable explicit-id
 * "only new" semantics. So:
 *   1. entries that pre-exist on the added stream are NOT delivered;
 *   2. entries written after the add ARE delivered;
 *   3. the stable cursor means a busy sibling cannot starve the added stream — its
 *      fresh entries arrive within a couple of blocking cycles even while the original
 *      stream is receiving a steady drip (the failure mode of a re-resolving '$').
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
const A_DRIP = 30; // < BLOCK: the sibling stream A is busy — reads return with A data every cycle

let writer: StreamingDataSource;
let reader: StreamingDataSource;
const keyA = `itest:onlynew:A:${uniq()}`;
const keyB = `itest:onlynew:B:${uniq()}`;

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
  message: JSON.stringify({}), sourceId: 'onlynew',
});

async function until(cond: () => boolean, ms: number, step = 15) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (cond()) return true; await sleep(step); }
  return cond();
}

describe('addStreamId only-new seeding + busy-sibling non-starvation (gap 11)', () => {
  test('pre-existing entries on an added stream are skipped; fresh ones arrive promptly despite a busy sibling', async () => {
    // B holds 3 PRE-EXISTING entries before the reader ever knows about it.
    await writeOne(keyB, 'pre-0');
    await writeOne(keyB, 'pre-1');
    await writeOne(keyB, 'pre-2');

    const received: Array<{ stream?: string; id: string }> = [];
    let dead = false;
    const stream = reader.getReadStream({ stream: keyA, last: '0', blockingTimeout: BLOCK });
    stream.on('data', (ev: MappedStreamEvent) => received.push({ stream: ev.streamId, id: ev.messageId }));
    stream.on('error', () => { dead = true; });
    stream.on('end', () => { dead = true; });

    // Busy sibling: steady drip on A at a period shorter than the blocking timeout,
    // so every read cycle returns immediately with A data (the starvation posture).
    let stopDrip = false; let n = 0;
    const drip = (async () => {
      while (!stopDrip) { await writeOne(keyA, `a-${n++}`); await sleep(A_DRIP); }
    })();
    await until(() => received.some((r) => r.id === 'a-4'), 5000); // reader live and tailing A

    reader.addStreamId(keyB);
    // Bounded settle: the add is folded in at the next loop top; give a few busy
    // cycles for the seed to be taken, then write the fresh entries.
    await sleep(3 * BLOCK);
    const tFresh = Date.now();
    await writeOne(keyB, 'fresh-0');
    await writeOne(keyB, 'fresh-1');

    // Non-starvation: fresh B entries arrive within a couple of blocking cycles even
    // while A keeps flowing. (Generous absolute bound; the assertion below pins the
    // couple-of-cycles latency.)
    const gotFresh = await until(
      () => received.some((r) => r.id === 'fresh-0') && received.some((r) => r.id === 'fresh-1'),
      3000,
    );
    const freshLatency = Date.now() - tFresh;
    await (async () => { stopDrip = true; await drip; })();

    expect(dead).toBe(false);
    expect(gotFresh).toBe(true);
    expect(freshLatency).toBeLessThanOrEqual(3 * BLOCK + 200); // ~a couple of blocking cycles

    // Only-new seeding: none of B's pre-existing entries were delivered.
    expect(received.filter((r) => r.id.startsWith('pre-')).length).toBe(0);
    // And the fresh ones are tagged to B, with A still flowing across the whole window.
    const fresh0 = received.find((r) => r.id === 'fresh-0');
    expect(fresh0?.stream).toBe(keyB);
    expect(received.filter((r) => r.id.startsWith('a-')).length).toBeGreaterThan(5);
  }, 20000);
});
