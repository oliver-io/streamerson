/**
 * Gap 8 (TESTING_ANALYSIS consumer gaps) — prefetch > 1 sad paths.
 *
 * Batching contract verified against src/member.ts `listen()`: one XREADGROUP pulls
 * up to `prefetch` entries (COUNT = prefetch), then the member terminalizes them
 * ONE AT A TIME (serial per-event loop, each ending in an atomic {record; XACK}).
 * Consequences pinned here:
 *  (a) a mid-batch handler throw (retry OFF) dead-letters ONLY that entry, inline —
 *      its batch siblings still terminalize to responses and the PEL drains;
 *  (b) the PEL never holds more than `prefetch` entries: read-ahead is bounded by
 *      the batch size, so a slow handler cannot let pending grow past the prefetch.
 *
 * Live Redis required. Run: bun test packages/consumer/test/prefetch-sad-paths.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, write, collectResponses, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const PREFETCH = 3;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('mid-batch throw (retry off): the bad entry dead-letters inline, siblings still respond, PEL drains', async () => {
  const topic = rig.topic('pf-throw');
  const GROUP = 'pf-throw-group';
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });

  // Backlog all three before the member starts, so one batched read can take them all.
  await write(admin, topic, 'job', 'pf-a', { n: 0 });
  await write(admin, topic, 'job', 'bad', { n: 1 });
  await write(admin, topic, 'job', 'pf-b', { n: 2 });

  const member = rig.track(new ConsumerGroupMember(
    {
      topic, redisConfiguration: REDIS, bidirectional: true, prefetch: PREFETCH,
      eventMap: {
        job: async (e: any) => {
          if (e.messageId === 'bad') throw new Error('mid-batch failure');
          return { ok: true, n: e.payload?.n };
        },
      },
    },
    { groupId: GROUP, groupMemberId: 'pft-1' },
  ));
  await member.connectAndListen();

  // Siblings of the failing entry still succeed.
  const seen = await collectResponses(topic, 2, 6000);
  expect(seen).toEqual(new Set(['pf-a', 'pf-b']));

  // The bad entry was dead-lettered inline (FAILED, no retry configured).
  await until(async () => (await readDlq(admin, topic)).length === 1, 4000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('bad');
  expect(dlq[0]?.reason).toBe('handler-threw');

  // Every batched entry terminalized — nothing left pending.
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
}, 30000);

test('slow consumer: pending never exceeds prefetch (read-ahead bound), and all entries eventually respond', async () => {
  const topic = rig.topic('pf-bound');
  const GROUP = 'pf-bound-group';
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });

  const N = 10;
  const HANDLER_MS = 150;
  for (let i = 0; i < N; i++) await write(admin, topic, 'slow', `pfb-${i}`, { n: i });

  const member = rig.track(new ConsumerGroupMember(
    {
      topic, redisConfiguration: REDIS, bidirectional: true, prefetch: PREFETCH,
      eventMap: { slow: async (e: any) => { await sleep(HANDLER_MS); return { ok: true, n: e.payload?.n }; } },
    },
    { groupId: GROUP, groupMemberId: 'pfb-1' },
  ));
  await member.connectAndListen();

  // Sample XPENDING while the backlog is worked (10 × 150ms ≈ 1.5s of processing).
  let maxPending = 0;
  const collected = collectResponses(topic, N, 15_000);
  const deadline = Date.now() + N * HANDLER_MS + 1000;
  while (Date.now() < deadline) {
    maxPending = Math.max(maxPending, await pendingCount(admin, topic, GROUP));
    await sleep(40);
  }

  // The read-ahead bound: a batch of at most `prefetch` is delivered, then worked
  // down serially before the next XREADGROUP — pending can never exceed prefetch.
  expect(maxPending).toBeGreaterThan(0);        // sampling actually observed in-flight work
  expect(maxPending).toBeLessThanOrEqual(PREFETCH);

  // Liveness: all entries respond and the PEL drains.
  expect((await collected).size).toBe(N);
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
}, 30000);
