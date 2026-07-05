/**
 * P1-7 — retry mode: cross-member reclaim (REQUEST_STREAM_RECEIPT.md §7).
 * Integration test against live Redis (`bun run start:redis`).
 *
 * Contract pinned here:
 *  - cross-member reclaim, DISTINCT ids: member A (retry on) throws and disconnects,
 *    leaving its entry pending; member B (different groupMemberId, same group, short
 *    grace) reclaims it via XAUTOCLAIM and its handler succeeds — the response arrives,
 *    the group PEL drains, and the entry is NOT dead-lettered;
 *  - concurrent reclaimers, exactly-once: a batch of entries abandoned to a phantom
 *    consumer is split between two concurrently-reclaiming members; every entry re-runs
 *    and responds exactly once (XAUTOCLAIM atomically claims + resets idle, so a second
 *    reclaimer's idle filter excludes an already-claimed entry).
 *
 * Run: bun test packages/consumer/test/cross-member-reclaim.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Topic } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, readEntries, write, awaitResponse, abandonToPhantom, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

function group(topic: Topic) { return `reclaim-${topic.topic}`; }

test('cross-member reclaim: member B (distinct id) reclaims member A\'s abandoned pending entry and succeeds', async () => {
  const topic = rig.topic('reclaim-cross');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  // Member A: retry on, but a huge grace so A never reclaims its own failure within the
  // test — the entry must be recovered by B, not by A's own reclaim/self-drain.
  let aRuns = 0;
  const a = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 60_000, retry: { maxAttempts: 5 }, eventMap: { work: async () => { aRuns++; throw new Error('A dies here'); } } },
    { groupId: g, groupMemberId: 'member-A' },
  );
  await a.connectAndListen();

  await write(admin, topic, 'work', 'x-1', { v: 1 });
  await until(() => aRuns >= 1, 4000);
  expect(aRuns).toBe(1);
  expect(await pendingCount(admin, topic, g)).toBe(1); // thrown -> left pending (retry mode)

  // A disconnects for real; its entry stays pending under consumer 'member-A'.
  await a.disconnect();
  await sleep(100); // let A's in-flight blocking read unwind

  // Member B: DISTINCT id, same group, short grace — reclaims A's entry once idle >= grace.
  let bRuns = 0;
  const b = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 300, retry: { maxAttempts: 5 }, eventMap: { work: async () => { bRuns++; return { ok: true, by: 'B' }; } } },
    { groupId: g, groupMemberId: 'member-B' },
  );
  await b.connectAndListen();
  rig.track(b);

  const got = await awaitResponse(topic, 'x-1', 8000);
  expect(got).toBeDefined();
  expect((got!.payload as any).by).toBe('B');
  expect(bRuns).toBeGreaterThanOrEqual(1);                 // B, not A, re-ran it
  expect(aRuns).toBe(1);
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 4000);
  expect(await pendingCount(admin, topic, g)).toBe(0);     // both PELs empty (group total)
  expect(await readDlq(admin, topic)).toHaveLength(0);     // recovered, not dead-lettered
}, 30000);

test('concurrent reclaimers: an abandoned batch is re-run and responded exactly once each across two members', async () => {
  const topic = rig.topic('reclaim-race');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  // Abandon a batch to a phantom consumer that never acks (a crashed member's PEL).
  const BATCH = 6;
  const ids = Array.from({ length: BATCH }, (_, i) => `o-${i + 1}`);
  for (const id of ids) await abandonToPhantom(admin, topic, g, id);
  expect(await pendingCount(admin, topic, g)).toBe(BATCH);

  // Two retry members start concurrently; the batch's idle clocks are already ticking
  // and grace is short, so both race to XAUTOCLAIM the same stale set.
  const runs = new Map<string, number>();                  // messageId -> handler executions (in-process)
  const handler = (who: string) => ({
    orphan: async (e: any) => {
      runs.set(e.messageId, (runs.get(e.messageId) ?? 0) + 1);
      return { ok: true, by: who };
    },
  });
  const opts = (who: string) => ({ topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 200, retry: { maxAttempts: 5 }, eventMap: handler(who) });
  const m1 = rig.track(new ConsumerGroupMember(opts('m1'), { groupId: g, groupMemberId: 'racer-1' }));
  const m2 = rig.track(new ConsumerGroupMember(opts('m2'), { groupId: g, groupMemberId: 'racer-2' }));
  await Promise.all([m1.connectAndListen(), m2.connectAndListen()]);

  // Every entry reaches the response stream and the group PEL fully drains.
  await until(async () => (await readEntries(admin, topic.producerKey())).length >= BATCH, 10000);
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 6000);

  // Stability window: give a late double-claim/double-respond a chance to misfire.
  await sleep(600);

  const responded = (await readEntries(admin, topic.producerKey())).map((f) => f.messageId);
  expect(responded.length).toBe(BATCH);                    // exactly once each — no duplicates
  expect(new Set(responded)).toEqual(new Set(ids));        // ...and every entry re-ran
  for (const id of ids) expect(runs.get(id)).toBe(1);      // sanity: single handler execution
  expect(await pendingCount(admin, topic, g)).toBe(0);     // both PELs empty
  expect(await readDlq(admin, topic)).toHaveLength(0);     // nothing dead-lettered
}, 30000);
