/**
 * Phase 2 (REQUEST_STREAM_RECEIPT.md §12) — coordinator/member split + create safety.
 * Integration test against live Redis (`bun run start:redis`).
 *
 * Contract pinned here:
 *  - CG-B2: a coordinator creates the group but NEVER consumes — every produced
 *    message reaches the real member, and no phantom '' consumer appears in the
 *    group (the old ConsumerGroupConfigurator read the group as consumer "" and
 *    dropped a share of messages it had no handler for);
 *  - CG-A5: a real (non-BUSYGROUP) create failure is surfaced to the caller, not
 *    swallowed;
 *  - D1: constructing a member with an empty groupMemberId is a hard error.
 *
 * Run: bun test packages/consumer/test/coordinator.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { StreamingDataSource } from '@streamerson/core';
import type { MappedStreamEvent } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, until, write, collectResponses, consumerNames, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('CG-B2: the coordinator creates the group but never consumes; the member gets every message', async () => {
  const topic = rig.topic('coord');
  const GROUP = 'coord-group';

  const coordinator = new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1 });
  await coordinator.connectAndListen();
  const created = await coordinator.create();
  expect(created.created).toBe(true);
  rig.onTeardown(() => coordinator.disconnect());

  const member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async (e: any) => ({ echoed: e.payload?.n }) } },
    { groupId: GROUP, groupMemberId: 'cm-1' },
  );
  await member.connectAndListen();
  rig.onTeardown(() => member.disconnect());

  // Read responses off the producer key.
  const reader = rig.track(new StreamingDataSource(REDIS));
  await reader.connect();
  const seen = new Set<string>();
  void (async () => {
    const stream = reader.getReadStream({ stream: topic.producerKey(), last: '0' });
    for await (const ev of stream as AsyncIterable<MappedStreamEvent>) {
      if (ev.messageId?.startsWith('c-')) seen.add(ev.messageId);
    }
  })();

  const N = 5;
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `c-${i}`, { n: i });

  // All N must be answered by the member (none stolen by a phantom '' consumer).
  await until(() => seen.size >= N, 6000);
  expect(seen.size).toBe(N);

  // Direct evidence: the only consumer registered in the group is the real member.
  const names = consumerNames(await admin.client.send('XINFO', ['CONSUMERS', topic.consumerKey(), GROUP]));
  expect(names.sort()).toEqual(['cm-1']);
  expect(names).not.toContain('');
}, 20000);

test('CG-A5: a non-BUSYGROUP create failure is surfaced, not swallowed', async () => {
  const topic = rig.topic('coord-wrongtype'); // its consumerKey is deleted at teardown
  // Occupy the consumer key with a string so XGROUP CREATE … MKSTREAM hits WRONGTYPE.
  await admin.client.send('SET', [topic.consumerKey(), 'not-a-stream']);

  const coordinator = new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: 'wt-group', count: 1 });
  await coordinator.connect();
  rig.onTeardown(() => coordinator.disconnect());

  let threw = false;
  try {
    await coordinator.create();
  } catch (err) {
    threw = true;
    expect(String((err as Error).message)).toContain('WRONGTYPE');
  }
  expect(threw).toBe(true);
});

test("CG-A4: create(cursor='0') delivers pre-group history to a joining member", async () => {
  const topic = rig.topic('coord-cursor');
  const GROUP = 'cursor-group';

  // Produce BEFORE the group exists — pre-group history (the stream is MKSTREAM'd by XADD).
  const N = 3;
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `h-${i}`, { n: i });

  const coordinator = new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1 });
  await coordinator.connect();
  const { created } = await coordinator.create('0');   // create from the start, not the default '$'
  expect(created).toBe(true);
  rig.onTeardown(() => coordinator.disconnect());

  const member = new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async (e: any) => ({ echoed: e.payload?.n }) } },
    { groupId: GROUP, groupMemberId: 'cur-1' },
  );
  await member.connectAndListen();
  rig.onTeardown(() => member.disconnect());

  // Because the group was created at '0', the member's '>' reads see the pre-group backlog.
  const seen = await collectResponses(topic, N, 6000);
  expect(seen.size).toBe(N);
}, 20000);

test('D1: constructing a member with an empty groupMemberId is a hard error', () => {
  const topic = rig.topic('coord-d1');
  expect(() => new ConsumerGroupMember({ topic, redisConfiguration: REDIS }, { groupId: 'g', groupMemberId: '' })).toThrow();
});
