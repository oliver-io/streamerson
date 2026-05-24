/**
 * Prefetch > 1. A member pulls up to `prefetch` entries per XREADGROUP and then
 * terminalizes them one at a time (member.listen). This exercises the multi-entry
 * batch path (parseStreamReply returning >1, the per-event terminal loop) and asserts
 * no entry is dropped at a batch boundary. Live Redis required (`bun run start:redis`).
 *
 * Run: bun test packages/consumer/test/prefetch.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, until, pendingCount, write, collectResponses, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('prefetch');
const GROUP = 'prefetch-group';
let member: ConsumerGroupMember<any> | undefined;
rig.onTeardown(() => member?.disconnect());

beforeAll(async () => {
  await rig.connect();
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });
});

afterAll(() => rig.teardown());

test('prefetch > 1 reads a batch and terminalizes every entry (no batch-boundary loss)', async () => {
  const N = 12;  // > prefetch, so multiple batched reads are required
  // Backlog the first reads pull as batches of `prefetch`.
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `pf-${i}`, { n: i });

  member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, prefetch: 5, eventMap: { echo: async (e: any) => ({ echoed: e.payload?.n }) } },
    { groupId: GROUP, groupMemberId: 'pf-1' },
  );
  await member.connectAndListen();

  const seen = await collectResponses(topic, N, 6000);
  expect(seen.size).toBe(N);                 // all answered across batched reads
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);  // every batched entry terminalized
}, 20000);
