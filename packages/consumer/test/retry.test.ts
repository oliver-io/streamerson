/**
 * Phase 4 (REQUEST_STREAM_RECEIPT.md §12, §7) — opt-in retry (at-least-once).
 * Integration test against live Redis (`bun run start:redis`).
 *
 * Contract pinned here:
 *  - redelivery after crash: a handler that throws leaves its entry pending; a member
 *    restarting under the SAME id re-runs it from its own PEL (self-drain) and an
 *    idempotent handler then succeeds — the message is not lost (at-least-once);
 *  - poison-message termination: a handler that always throws is re-run up to
 *    `maxAttempts` delivery attempts, then dead-lettered (liveness — it can't loop
 *    forever);
 *  - CG-I7: with `processingTimeout` (the reclaim idle threshold) greater than the
 *    handler time, reclaim does NOT steal a healthy in-flight entry — it executes
 *    exactly once.
 *
 * Run: bun test packages/consumer/test/retry.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Topic } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, write, awaitResponse, testRig } from './harness';

// The rig disconnects every tracked member (stopping its read loop) and settles BEFORE
// deleting the group/stream, so a live loop never reads a vanished group (NOGROUP noise).
const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

function group(topic: Topic) { return `retry-${topic.topic}`; }

test('redelivery after crash: a restarted member self-drains its own PEL and an idempotent handler succeeds', async () => {
  const topic = rig.topic('retry-self');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const attempts = new Map<string, number>();
  // Idempotent-ish handler: fails the first delivery, succeeds on re-run.
  const makeHandler = () => ({
    work: async (e: any) => {
      const id = e.messageId as string;
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      if (n === 1) throw new Error('transient failure');
      return { done: true, tries: n };
    },
  });
  const opts = () => ({ topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 5000, retry: { maxAttempts: 5 }, eventMap: makeHandler() });

  // Member 1 takes the message via '>', fails, leaves it pending — then "crashes".
  const m1 = new ConsumerGroupMember(opts(), { groupId: g, groupMemberId: 'rm-1' });
  await m1.connectAndListen();
  await write(admin, topic, 'work', 'w-1', { hi: 'there' });
  await until(() => (attempts.get('w-1') ?? 0) >= 1, 4000);
  expect(attempts.get('w-1')).toBe(1);
  await m1.disconnect();
  await sleep(100); // let m1's in-flight blocking read unwind before m2 (same id) starts

  // Member 2, SAME id, re-runs the pending entry from its own PEL on startup.
  const m2 = new ConsumerGroupMember(opts(), { groupId: g, groupMemberId: 'rm-1' });
  await m2.connectAndListen();
  rig.track(m2);

  const got = await awaitResponse(topic, 'w-1', 5000);
  expect(got).toBeDefined();
  expect((got!.payload as any).done).toBe(true);
  expect(attempts.get('w-1')).toBeGreaterThanOrEqual(2);   // ran again (at-least-once)
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);     // acked, drained
  expect(await readDlq(admin, topic)).toHaveLength(0);     // not dead-lettered
}, 30000);

test('poison message: an always-failing handler is re-run up to maxAttempts, then dead-lettered', async () => {
  const topic = rig.topic('retry-poison');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  let invocations = 0;
  const member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 300, retry: { maxAttempts: 2 }, eventMap: { boom: async () => { invocations++; throw new Error('always fails'); } } },
    { groupId: g, groupMemberId: 'pm-1' },
  );
  await member.connectAndListen();
  rig.track(member);

  await write(admin, topic, 'boom', 'p-1', { x: 1 });

  // Re-run via reclaim every ~grace; poison after delivery count passes maxAttempts.
  await until(async () => (await readDlq(admin, topic)).length === 1, 4000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('p-1');
  expect(dlq[0]?.reason).toBe('handler-threw');
  expect(Number(dlq[0]?.deliveryCount)).toBeGreaterThan(2);  // exceeded maxAttempts
  expect(invocations).toBeGreaterThanOrEqual(2);              // re-run, not dropped on first failure
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);        // terminalized out of the PEL
}, 30000);

test('CG-I7: reclaim does not steal a healthy in-flight entry when processingTimeout > handler time', async () => {
  const topic = rig.topic('retry-noi7');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  let runs = 0;
  const member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 1000, retry: { maxAttempts: 3 }, eventMap: { slow: async () => { runs++; await sleep(150); return { ok: true }; } } },
    { groupId: g, groupMemberId: 'sm-1' },
  );
  await member.connectAndListen();
  rig.track(member);

  await write(admin, topic, 'slow', 's-1', { v: 1 });
  const got = await awaitResponse(topic, 's-1', 4000);
  expect(got).toBeDefined();

  // Past a reclaim interval: a completed (acked) entry idle < grace is never reclaimed,
  // so the handler ran exactly once. (Negative/stability assertion — needs a real window.)
  await sleep(1500);
  expect(runs).toBe(1);
  expect(await pendingCount(admin, topic, g)).toBe(0);
  expect(await readDlq(admin, topic)).toHaveLength(0);
}, 30000);
