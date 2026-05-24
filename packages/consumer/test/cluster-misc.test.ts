/**
 * Cluster lifecycle odds-and-ends against live Redis (`bun run start:redis`):
 *  - `isRunning` reflects start/stop;
 *  - `fill()` is a working alias for `start()` (back-compat);
 *  - a worker whose factory throws at build time signals `error` and exits non-zero
 *    (cluster-member.ts), so the coordinator observes the member never became ready and
 *    `start()` rejects rather than hanging.
 *
 * Run: bun test packages/consumer/test/cluster-misc.test.ts
 */
import { test, expect, afterEach, describe } from 'bun:test';
import path from 'path';
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, makeTopic, cleanupKeys } from './harness';

const echoFixture = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');
const failingFixture = path.resolve(import.meta.dir, 'fixtures', 'cluster-failing-member.ts');

const admin = new StreamingDataSource(REDIS);
let adminConnected = false;
async function ensureAdmin() { if (!adminConnected) { await admin.connect(); adminConnected = true; } }

let cluster: ConsumerGroupCluster | undefined;
let topic: ReturnType<typeof makeTopic> | undefined;

afterEach(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  cluster = undefined;
  await sleep(100);
  if (topic && adminConnected) { await cleanupKeys(admin, topic); }
  topic = undefined;
});

describe('ConsumerGroupCluster lifecycle flags', () => {
  test('isRunning tracks start→stop, and fill() brings the cluster up like start()', async () => {
    await ensureAdmin();
    topic = makeTopic('clu-run');
    cluster = new ConsumerGroupCluster(
      { topic, bidirectional: true, redisConfiguration: REDIS },
      { name: 'run-group', count: 1, processingTimeout: 1000, idleTimeout: 300 },
      echoFixture,
    );

    expect(cluster.isRunning).toBe(false);   // not started yet
    await cluster.fill();                     // deprecated alias → start()
    expect(cluster.isRunning).toBe(true);     // running
    expect(cluster.readyMembers).toBe(1);     // fill() spawned the member, same as start()

    await cluster.stop();
    expect(cluster.isRunning).toBe(false);    // stopped
  }, 30000);

  test('a member whose factory throws at build → error+exit1 → start() rejects (not a hang)', async () => {
    await ensureAdmin();
    topic = makeTopic('clu-fail');
    cluster = new ConsumerGroupCluster(
      { topic, bidirectional: true, redisConfiguration: REDIS },
      { name: 'fail-group', count: 1, processingTimeout: 1000, idleTimeout: 300 },
      failingFixture,
    );

    // The worker posts `error` and exits 1; the coordinator sees a member that exited
    // before ever becoming ready and surfaces it (rather than waiting forever).
    await expect(cluster.start()).rejects.toThrow(/exited before becoming ready/);
    expect(cluster.readyMembers).toBe(0); // nothing came up
  }, 30000);
});
