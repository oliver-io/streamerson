/**
 * One-way (non-bidirectional) terminality. A member with `bidirectional: false` has
 * no producer channel, so a successful handler is terminalized with a plain XACK
 * (member.terminal → markProcessedByGroup), not the atomic {XADD response; XACK}.
 * The rest of the suite is bidirectional:true, so this is the only coverage of that
 * branch. Live Redis required (`bun run start:redis`).
 *
 * Run: bun test packages/consumer/test/oneway.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, until, pendingCount, readDlq, write, xlen, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('oneway');
const GROUP = 'oneway-group';
let member: ConsumerGroupMember<any> | undefined;
rig.onTeardown(() => member?.disconnect());

beforeAll(async () => {
  await rig.connect();
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });
});

afterAll(() => rig.teardown());

test("a one-way (non-bidirectional) success is plain-XACK'd: no response written, PEL drains", async () => {
  let invoked = 0;
  member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: false, eventMap: { ping: async () => { invoked++; return { pong: true }; } } },
    { groupId: GROUP, groupMemberId: 'ow-1' },
  );
  await member.connectAndListen();

  await write(admin, topic, 'ping', 'o-1', { hi: 1 });

  await until(() => invoked >= 1, 4000);
  expect(invoked).toBe(1);

  // Plain XACK terminal: the request leaves the PEL, nothing is written to the producer
  // key (a one-way member has no outgoing channel), and it is not a failure.
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
  expect(await xlen(admin, topic.producerKey())).toBe(0);
  expect(await readDlq(admin, topic)).toHaveLength(0);
}, 20000);
