/**
 * Phase 5 (REQUEST_STREAM_RECEIPT.md §12) — cluster verify & extend. The Bun-Worker
 * cluster is already built (D4); this exercises the lifecycle behaviors the spec calls
 * out: member longevity under sustained load, `scale()` up/down reconcile, and graceful
 * drain flushing an in-flight handler within `idleTimeout`. Live Redis required.
 *
 * Run: bun test packages/consumer/test/cluster-lifecycle.test.ts
 */
import { test, expect, afterEach } from 'bun:test';
import path from 'path';
import { StreamingDataSource, Topic } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, makeTopic, pendingCount, write, collectResponses, xlen } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');

let cluster: ConsumerGroupCluster | undefined;
let topic: Topic | undefined;
const admin = new StreamingDataSource(REDIS);
let adminConnected = false;

async function ensureAdmin() { if (!adminConnected) { await admin.connect(); adminConnected = true; } }

afterEach(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  cluster = undefined;
  await sleep(100);
  if (topic && adminConnected) {
    try { await admin.client.send('DEL', [topic.consumerKey(), topic.producerKey(), topic.deadLetterKey()]); } catch { /* */ }
  }
  topic = undefined;
});

test('members stay alive under sustained load and the group distributes every message', async () => {
  await ensureAdmin();
  topic = makeTopic('clu-load');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'load-group', count: 3, processingTimeout: 2000, idleTimeout: 500 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(3);

  const N = 30;
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `load-${i}`, { hi: i });

  const seen = await collectResponses(topic, N, 8000);
  expect(seen.size).toBe(N);                 // every message handled exactly once, distributed
  expect(cluster.readyMembers).toBe(3);      // all members survived the load
}, 30000);

test('scale() reconciles the live member count up and down', async () => {
  await ensureAdmin();
  topic = makeTopic('clu-scale');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'scale-group', count: 2, processingTimeout: 2000, idleTimeout: 400 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(2);

  await cluster.scale(4);
  expect(cluster.count).toBe(4);
  expect(cluster.readyMembers).toBe(4);

  await cluster.scale(1);
  expect(cluster.count).toBe(1);
  expect(cluster.members).toBe(1);

  // The lone survivor still serves requests.
  await write(admin, topic, 'echo', 'scale-after', { hi: 'alive' });
  const seen = await collectResponses(topic, 1, 5000);
  expect(seen.has('scale-after')).toBe(true);
}, 30000);

test('graceful stop drains an in-flight handler and flushes its response within idleTimeout', async () => {
  await ensureAdmin();
  topic = makeTopic('clu-drain');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'drain-group', count: 1, processingTimeout: 2000, idleTimeout: 1500 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  // Hand the member a 600ms job, let it get mid-flight, then stop the cluster.
  await write(admin, topic, 'slow', 'drain-1', { ms: 600 });
  await sleep(250); // intentional: let the handler get in-flight before draining
  await cluster.stop();   // drains: finish in-flight + flush response, then disconnect

  // The response must have been written during the drain (not lost to the close).
  const seen = await collectResponses(topic, 1, 4000);
  expect(seen.has('drain-1')).toBe(true);

  // And it was acked atomically with the response — nothing left pending.
  await until(async () => (await pendingCount(admin, topic, 'drain-group')) === 0, 2000);
  expect(await pendingCount(admin, topic, 'drain-group')).toBe(0);
}, 30000);

test('a handler that overruns idleTimeout is abandoned on stop — left pending (no loss), and stop still returns', async () => {
  await ensureAdmin();
  topic = makeTopic('clu-overrun');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // Big handler budget/reaper grace (won't fire), tiny drain budget (the handler can't finish in it).
    { name: 'overrun-group', count: 1, processingTimeout: 5000, idleTimeout: 300 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  await write(admin, topic, 'slow', 'overrun-1', { ms: 2000 });
  await sleep(250); // let the handler get in-flight
  const t0 = Date.now();
  await cluster.stop();                       // drains: waits idleTimeout, then disconnects mid-handler
  expect(Date.now() - t0).toBeLessThan(2000); // stop did not block on the full 2000ms handler

  // The abrupt close left the in-flight entry pending in the PEL — recoverable by a
  // future reaper/retry, never silently lost — and no partial response was flushed.
  await until(async () => (await pendingCount(admin, topic, 'overrun-group')) === 1, 2000);
  expect(await pendingCount(admin, topic, 'overrun-group')).toBe(1);
  expect(await xlen(admin, topic.producerKey())).toBe(0);
}, 30000);
