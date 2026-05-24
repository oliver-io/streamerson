/**
 * Backlog delivery (CG-C3). A message produced AFTER the group exists but BEFORE a
 * member connects must still be delivered once the member starts reading: the group
 * '>' cursor hands a joining member every never-delivered entry, regardless of
 * connect order. Ports the intent of the legacy (defunct) consumer-existing-messages.ts
 * — "old messages published before connection" — to the coordinator/member architecture.
 *
 * Integration test against live Redis (`bun run start:redis`). Drives a single member
 * directly so we can inspect the group PEL via XPENDING.
 *
 * Run: bun test packages/consumer/test/backlog.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, until, pendingCount, write, collectResponses, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('backlog');
const GROUP = 'backlog-group';
let member: ConsumerGroupMember<any> | undefined;
rig.onTeardown(() => member?.disconnect());

beforeAll(async () => {
  await rig.connect();
  // Group exists (at '$') before any backlog is produced — so the entries below are
  // never-delivered group backlog, not pre-group history.
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });
});

afterAll(() => rig.teardown());

test('backlog produced before a member connects is delivered once the member starts (CG-C3)', async () => {
  const N = 5;
  // Produce the backlog while NO member is listening.
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `b-${i}`, { n: i });

  // Now connect the member; its first '>' reads must drain the pre-existing backlog.
  member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async (e: any) => ({ echoed: e.payload?.n }) } },
    { groupId: GROUP, groupMemberId: 'bm-1' },
  );
  await member.connectAndListen();

  const seen = await collectResponses(topic, N, 6000);
  expect(seen.size).toBe(N);                 // every backlog entry handled after a late connect
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);      // all terminalized (acked) — none stranded
}, 20000);
