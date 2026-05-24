/**
 * Phase 3 (REQUEST_STREAM_RECEIPT.md §12) — terminality: atomic terminal transitions.
 * Integration test against live Redis (`bun run start:redis`). Reaper disabled here
 * (processingTimeout = 0) so the member's *inline* transitions are isolated.
 *
 * Contract pinned here:
 *  - RESPOND_AND_ACK: a bidirectional success leaves the response on the producer
 *    stream AND the request acked (PEL drained) — both effects, atomically;
 *  - DEADLETTER_AND_ACK (inline): a handler-throw is recorded in the DLQ with reason
 *    'handler-threw', a no-handler with reason 'no-handler', and both are acked;
 *  - after all messages, the group PEL is empty: every message reached a terminal state.
 *
 * Run: bun test packages/consumer/test/terminality.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, until, pendingCount, readDlq, write, awaitResponse, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('term');
const GROUP = 'term-group';
let coordinator: ConsumerGroupCoordinator | undefined;
let member: ConsumerGroupMember<any> | undefined;
rig.onTeardown(() => coordinator?.disconnect());
rig.onTeardown(() => member?.disconnect()); // LIFO ⇒ member (reader) disconnects first

beforeAll(async () => {
  await rig.connect();
  coordinator = new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1, processingTimeout: 0 });
  await coordinator.connectAndListen();
  await coordinator.create();
});

afterAll(() => rig.teardown());

test('atomic terminal transitions: respond+ack on success, dead-letter+ack on failure; PEL drains', async () => {
  member = new ConsumerGroupMember(
    {
      topic, redisConfiguration: REDIS, bidirectional: true,
      eventMap: {
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
        boom: async () => { throw new Error('handler boom'); },
      },
    },
    { groupId: GROUP, groupMemberId: 'tm-1' },
  );
  await member.connectAndListen();

  await write(admin, topic, 'echo', 't-echo', { hi: 'world' });   // -> DONE (RESPOND_AND_ACK)
  await write(admin, topic, 'boom', 't-boom', { x: 1 });           // -> FAILED handler-threw
  await write(admin, topic, 'mystery', 't-mystery', { y: 2 });     // -> FAILED no-handler

  // RESPOND_AND_ACK postcondition: the response is present.
  const got = await awaitResponse(topic, 't-echo', 4000);
  expect(got).toBeDefined();
  expect(got!.payload).toEqual({ ok: true, echoed: 'world' });

  // Both failures are durably dead-lettered with the right cause + provenance.
  await until(async () => (await readDlq(admin, topic)).length >= 2, 4000);
  const dlq = await readDlq(admin, topic);
  const byId = Object.fromEntries(dlq.map((e) => [e.messageId, e]));
  expect(byId['t-boom']?.reason).toBe('handler-threw');
  expect(byId['t-boom']?.consumer).toBe('tm-1');
  expect(byId['t-mystery']?.reason).toBe('no-handler');
  expect(dlq.length).toBe(2);

  // Every message reached a terminal state: the PEL is empty (echo acked atomically
  // with its response; both failures acked atomically with their dead-letter record).
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
}, 20000);
