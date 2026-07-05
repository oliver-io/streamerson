/**
 * Gap 6 (TESTING_ANALYSIS consumer gaps) — scale-down under load conserves messages.
 *
 * A cluster of 3 echo members takes a steady stream of 30 messages while scale(1)
 * fires mid-stream. Contract (src/cluster.ts scale → drainMember; src/member.ts drain):
 * a drained member stops pulling new work and finishes its in-flight entry, so after
 * quiescence EVERY written messageId is accounted for — a response XOR still-pending
 * XOR dead-lettered — with no duplicates and no losses.
 *
 * Ghost consumers: nothing in the codebase issues XGROUP DELCONSUMER (verified by
 * grep), so drained members' consumer names REMAIN registered in the group after
 * scale-down. Pinned here: XINFO CONSUMERS may list all spawned member names, but
 * every ghost must show pending 0 (their PELs drained before exit).
 *
 * Live Redis required. Run: bun test packages/consumer/test/scale-down-under-load.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, pendingCount, readDlq, readEntries, write, collectResponses, testRig, consumerNames } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('scale-load');
const GROUP = 'scale-load-group';
const N = 30;

let cluster: ConsumerGroupCluster | undefined;
rig.onTeardown(async () => { try { await cluster?.stop(); } catch { /* */ } });

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('scale(1) mid-stream: every messageId is accounted for, no duplicates, one member remains', async () => {
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // Big reaper grace so the reaper cannot steal in-flight work during the test.
    { name: GROUP, count: 3, processingTimeout: 10_000, idleTimeout: 1000 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(3);

  // Steady producer: 30 messages, ~10ms apart; scale(1) fires after message 10.
  const ids = Array.from({ length: N }, (_, i) => `sl-${i}`);
  let scaled: Promise<void> | undefined;
  for (let i = 0; i < N; i++) {
    await write(admin, topic, 'echo', ids[i], { hi: i });
    if (i === 10) scaled = cluster.scale(1);
    await sleep(10);
  }
  await scaled;
  expect(cluster.count).toBe(1);
  expect(cluster.members).toBe(1);

  // Quiescence: the survivor works down the backlog.
  const responded = await collectResponses(topic, N, 15_000);

  // Conservation audit from Redis ground truth. Responses come off the producer
  // key raw so duplicates are visible (collectResponses de-dupes into a Set).
  const responses = (await readEntries(admin, topic.producerKey())).map((f) => f.messageId);
  const dlqIds = (await readDlq(admin, topic)).map((f) => f.messageId);
  // Pending stream-ids → messageIds via the consumer stream's own entries.
  const pendingRaw = await admin.client.send('XPENDING', [topic.consumerKey(), GROUP, '-', '+', '1000']) as Array<[string, ...unknown[]]>;
  const byStreamId = new Map<string, string>();
  {
    const reply = await admin.client.send('XRANGE', [topic.consumerKey(), '-', '+']) as Array<[string, string[]]>;
    for (const [sid, kv] of reply ?? []) {
      for (let i = 0; i + 1 < kv.length; i += 2) if (kv[i] === 'messageId') byStreamId.set(sid, kv[i + 1]);
    }
  }
  const pendingIds = (pendingRaw ?? []).map(([sid]) => byStreamId.get(String(sid)) ?? String(sid));

  // No duplicate responses.
  expect(new Set(responses).size).toBe(responses.length);
  // Every id accounted for exactly once across the three terminal/pending buckets.
  for (const id of ids) {
    const buckets = Number(responses.includes(id)) + Number(pendingIds.includes(id)) + Number(dlqIds.includes(id));
    expect(`${id}:${buckets}`).toBe(`${id}:1`);
  }
  // With fast echo handlers the expected steady state is: all responded.
  expect(responded.size).toBe(N);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);

  // Ghost-consumer pin: drained members' names remain (no XGROUP DELCONSUMER in the
  // codebase), but no ghost holds pending work.
  const info = await admin.client.send('XINFO', ['CONSUMERS', topic.consumerKey(), GROUP]) as unknown[];
  const names = consumerNames(info);
  expect(names.length).toBeGreaterThanOrEqual(1);
  expect(names.length).toBeLessThanOrEqual(3); // the 3 spawned members, ghosts included
  for (const c of info as any[]) {
    const pending = Array.isArray(c) ? Number(c[c.indexOf('pending') + 1]) : Number(c.pending);
    expect(pending).toBe(0);
  }
}, 40000);
