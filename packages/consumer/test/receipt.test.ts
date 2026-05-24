/**
 * Phase 1 (REQUEST_STREAM_RECEIPT.md §12) — no silent loss. Integration test
 * against live Redis (`bun run start:redis`). Drives a single group member
 * directly (no cluster) so we can inspect the group PEL via XPENDING.
 *
 * Contract pinned here (updated for Phase 3 terminality):
 *  - a handler that THROWS is recorded as terminal FAILED in the dead-letter stream
 *    (reason 'handler-threw') rather than silently dropped (NOACK would lose it);
 *  - that failure does NOT wedge the read loop — a later message is still handled
 *    and answered (the pre-fix Transform `.catch` never called `callback()`);
 *  - a successful handler's response + ack are atomic, so the PEL drains to empty;
 *  - an idle member does not leak `keyEvents('update')` listeners (CG-I1).
 *
 * Run: bun test packages/consumer/test/receipt.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, write, awaitResponse, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('receipt');
const GROUP = 'receipt-group';
let member: ConsumerGroupMember<any> | undefined;
rig.onTeardown(() => member?.disconnect());

beforeAll(async () => {
  await rig.connect();
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });
});

afterAll(() => rig.teardown());

test('handler failure stays recoverable in the PEL and does not wedge the loop; success acks', async () => {
  member = new ConsumerGroupMember(
    {
      topic,
      redisConfiguration: REDIS,
      bidirectional: true,
      eventMap: {
        boom: async () => { throw new Error('handler boom'); },
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
      },
    },
    { groupId: GROUP, groupMemberId: 'm1' },
  );
  await member.connectAndListen();

  // A failing message, then a succeeding one behind it.
  await write(admin, topic, 'boom', 'r-boom', {});
  await write(admin, topic, 'echo', 'r-echo', { hi: 'world' });

  // The loop must have moved past the throw and answered the echo.
  const got = await awaitResponse(topic, 'r-echo', 4000);
  expect(got).toBeDefined();
  expect(got!.payload).toEqual({ ok: true, echoed: 'world' });

  // The failed message is recorded as terminal FAILED in the DLQ (not lost, not stuck
  // pending); the succeeded one was acked atomically with its response. PEL drains.
  await until(async () => (await readDlq(admin, topic)).some((e) => e.messageId === 'r-boom'), 3000);
  const dlq = await readDlq(admin, topic);
  expect(dlq.find((e) => e.messageId === 'r-boom')?.reason).toBe('handler-threw');
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);

  // CG-I1: an idle member must not accumulate UPDATE listeners — let several BLOCK
  // cycles elapse, then assert no growth (stability check, so a real wait is correct).
  await sleep(400);
  expect(member.incomingChannel.keyEvents.listenerCount('update')).toBeLessThanOrEqual(2);
}, 20000);
