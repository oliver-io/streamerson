/**
 * Reaper negative space (REQUEST_STREAM_RECEIPT.md §6): the reaper terminalizes
 * only entries that were DELIVERED and then abandoned (they're in a PEL with an
 * idle clock). It must never touch (a) a never-delivered backlog — XAUTOCLAIM
 * only scans the PEL — or (b) a slow-but-alive handler whose runtime sits well
 * inside the grace (the inverse of the reaper-steal-slow-member test).
 *
 * Live Redis required. Run: bun test packages/consumer/test/reaper-negative.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Topic } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, sleep, until, pendingCount, readDlq, write, collectResponses, xlen, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

function group(topic: Topic) { return `rneg-${topic.topic}`; }

test('never-delivered backlog is NOT reaped: undelivered entries outlive many grace periods, then a member answers all of them', async () => {
  const topic = rig.topic('rneg-backlog');
  const g = group(topic);
  const grace = 300;

  // Group exists, reaper runs, but NO member is attached — the 5 messages are pure
  // backlog (never delivered, so never in any PEL, so invisible to XAUTOCLAIM).
  const coordinator = rig.track(new ConsumerGroupCoordinator(
    { topic, redisConfiguration: REDIS },
    { name: g, processingTimeout: grace },
  ));
  await coordinator.connect();
  await coordinator.create();           // cursor '$' — subsequent writes are backlog
  coordinator.startReaper();

  const N = 5;
  for (let i = 0; i < N; i++) await write(admin, topic, 'work', `bk-${i}`, { v: i });

  // Negative/stability check: > 3 grace periods with the reaper sweeping.
  await sleep(grace * 4);
  expect(await readDlq(admin, topic)).toHaveLength(0);      // nothing reaped
  expect(await xlen(admin, topic.consumerKey())).toBe(N);   // backlog intact
  expect(await pendingCount(admin, topic, g)).toBe(0);      // still undelivered

  // Attach a member: every backlog message is answered.
  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { work: async (e: any) => ({ ok: true, v: e.payload?.v }) } },
    { groupId: g, groupMemberId: 'bk-1' },
  ));
  await member.connectAndListen();

  const seen = await collectResponses(topic, N, 8000);
  expect(seen.size).toBe(N);
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);
  expect(await readDlq(admin, topic)).toHaveLength(0);
}, 30000);

test('reaper does not steal a slow-but-alive handler when grace comfortably exceeds handler time', async () => {
  const topic = rig.topic('rneg-slow');
  const g = group(topic);

  // Grace 2000ms vs 150ms handler: an in-flight entry is never idle >= grace.
  const coordinator = rig.track(new ConsumerGroupCoordinator(
    { topic, redisConfiguration: REDIS },
    { name: g, processingTimeout: 2000 },
  ));
  await coordinator.connect();
  await coordinator.create();
  coordinator.startReaper();

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { slow: async (e: any) => { await sleep(150); return { ok: true, v: e.payload?.v }; } } },
    { groupId: g, groupMemberId: 'sl-1' },
  ));
  await member.connectAndListen();

  const N = 5;
  for (let i = 0; i < N; i++) await write(admin, topic, 'slow', `sl-${i}`, { v: i });

  const seen = await collectResponses(topic, N, 10000);
  expect(seen.size).toBe(N);                            // all answered by the live member

  // Let a full reaper sweep pass over the (now fully acked) history, then assert
  // nothing was ever stolen/dead-lettered (negative check needs a real window).
  await sleep(2500);
  expect(await readDlq(admin, topic)).toHaveLength(0);
  expect(await pendingCount(admin, topic, g)).toBe(0);
}, 30000);
