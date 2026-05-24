/**
 * Integration test (per dev principle: integration over unit). Drives the real
 * cluster path against a live Redis: the coordinator creates the group and
 * spawns long-lived members as Bun Worker threads; a request written to the
 * consumer stream is handled inside a worker and its response is read back off
 * the producer stream. Also covers restart-on-crash. Requires Redis on
 * localhost:6379 (`bun run start:redis`).
 *
 * Run: bun test packages/consumer/test/cluster.test.ts
 */
import { test, expect, afterAll } from 'bun:test';
import path from 'path';
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, makeTopic, write, awaitResponse, cleanupKeys } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');
const topic = makeTopic('cluster');

const writer = new StreamingDataSource(REDIS);
let cluster: ConsumerGroupCluster | undefined;

afterAll(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  await sleep(150);
  await cleanupKeys(writer, topic);
  try { await writer.disconnect(); } catch { /* */ }
});

test('cluster member round-trips a request through a Bun worker thread', async () => {
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'itest-cluster', count: 2, processingTimeout: 2000, idleTimeout: 500 },
    fileTarget,
  );

  await cluster.start();
  expect(cluster.count).toBe(2);
  expect(cluster.readyMembers).toBe(2);

  await writer.connect();
  await write(writer, topic, 'echo', 'cluster-m1', { hi: 'cluster' });

  const got = await awaitResponse(topic, 'cluster-m1', 8000);
  expect(got).toBeDefined();
  expect(got!.messageId).toBe('cluster-m1');
  expect(got!.payload).toEqual({ ok: true, echoed: 'cluster' });
}, 20000);

test('coordinator restarts a crashed member to maintain the desired count', async () => {
  expect(cluster).toBeDefined();
  expect(cluster!.readyMembers).toBe(2);

  // Delivered to exactly one member (consumer-group distribution); its handler
  // exits the worker, so the coordinator must respawn it back to count.
  await write(writer, topic, 'boom', 'cluster-boom', { die: true });

  // Observe the crash: a member drops out of the ready set.
  const dipped = await until(() => cluster!.readyMembers < 2, 6000);
  expect(dipped).toBe(true);

  // Observe recovery: the coordinator respawns and the replacement becomes ready.
  await until(() => cluster!.readyMembers === 2, 10000);
  expect(cluster!.readyMembers).toBe(2);
}, 20000);
