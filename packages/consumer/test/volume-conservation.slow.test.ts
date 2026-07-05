/**
 * P3-19 — the tagged SLOW conservation guard (Part-9-style stress, resurrected as
 * a regression test; named *.slow.test.ts so it can be filtered out of quick runs).
 *
 * 300 messages across a cluster of 3 echo members must exhibit exactly-once
 * distribution at the observable contract level: 300 distinct responses on the
 * producer stream (raw XRANGE, so duplicates would be visible), an empty PEL,
 * and an empty DLQ. Volume kept CI-sane (300, not 1000) per the audit note.
 *
 * Live Redis required. Run: bun test packages/consumer/test/volume-conservation.slow.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, pendingCount, readDlq, readEntries, write, collectResponses, testRig } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('vol');
const GROUP = 'vol-group';
const N = 300;

let cluster: ConsumerGroupCluster | undefined;
rig.onTeardown(async () => { try { await cluster?.stop(); } catch { /* */ } });

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('300 messages across 3 members: 300 distinct responses, no duplicates, PEL 0, DLQ 0', async () => {
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // Big reaper grace: the reaper must not steal in-flight work under load.
    { name: GROUP, count: 3, processingTimeout: 10_000, idleTimeout: 500 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(3);

  const ids = new Set<string>();
  for (let i = 0; i < N; i++) {
    const id = `vol-${i}`;
    ids.add(id);
    await write(admin, topic, 'echo', id, { hi: i });
  }

  const seen = await collectResponses(topic, N, 45_000);
  expect(seen.size).toBe(N);
  for (const id of ids) expect(seen.has(id)).toBe(true);

  // Raw producer-stream audit: exactly N entries, all ids distinct (no duplicates).
  const raw = (await readEntries(admin, topic.producerKey())).map((f) => f.messageId);
  expect(raw.length).toBe(N);
  expect(new Set(raw).size).toBe(N);

  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
  expect(await readDlq(admin, topic)).toHaveLength(0);
  expect(cluster.readyMembers).toBe(3); // all members survived the volume
}, 60000);
