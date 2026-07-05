/**
 * RED regression test (TESTING_ANALYSIS consumer gap 4; confirmed bug #5):
 * a respawned member that crashes BEFORE signalling ready must not silently and
 * permanently reduce the cluster below `desiredCount`. Today `spawnMember`'s
 * pre-ready `close` rejects into a log-only `.catch` and nothing reschedules,
 * so the cluster sits under-count forever (contradicting `cluster.ts`'s own
 * supervision contract: "keeps the desired member count alive across crashes").
 *
 * Real path end-to-end: real Redis, real Bun worker threads, a real handler
 * crash (`process.exit(1)`), and a respawn that genuinely dies pre-ready
 * (fixture spawn #2). Spawn #3+ is healthy, so a correct supervisor recovers.
 * EXPECTED TO FAIL until the respawn hole is fixed.
 * Requires Redis (`bun run start:redis`).
 */
import { test, expect, afterAll } from 'bun:test';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, makeTopic, write, cleanupKeys, awaitResponse } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-respawn-crash-member.ts');
const topic = makeTopic('respawn-failure');
const counterFile = path.join(os.tmpdir(), `streamerson-respawn-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);

const writer = new StreamingDataSource(REDIS);
let cluster: ConsumerGroupCluster | undefined;

afterAll(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  await sleep(150);
  await cleanupKeys(writer, topic);
  try { await writer.disconnect(); } catch { /* */ }
  try { fs.unlinkSync(counterFile); } catch { /* */ }
});

test('a respawn that crashes pre-ready is retried until the cluster is back at desired count', async () => {
  process.env['RESPAWN_FIXTURE_FILE'] = counterFile;
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'itest-respawn', count: 1, processingTimeout: 2000, idleTimeout: 500 },
    fileTarget,
  );

  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  // Sanity: the healthy first spawn actually serves traffic.
  await writer.connect();
  await write(writer, topic, 'echo', 'respawn-m1', { hi: 'there' });
  expect(await awaitResponse(topic, 'respawn-m1', 8000)).toBeDefined();

  // Real crash: the handler hard-exits the worker thread.
  await write(writer, topic, 'boom', 'respawn-boom', { die: true });
  expect(await until(() => cluster!.readyMembers === 0, 6000)).toBe(true);

  // The supervisor's respawn (fixture spawn #2) dies before ready. The intended
  // contract: keep reconciling toward desiredCount — spawn #3 is healthy, so the
  // cluster must come back to 1 ready member and serve traffic again.
  const recovered = await until(() => cluster!.readyMembers === 1, 12000);
  expect(recovered).toBe(true);

  await write(writer, topic, 'echo', 'respawn-m2', { hi: 'again' });
  expect(await awaitResponse(topic, 'respawn-m2', 8000)).toBeDefined();
}, 40000);
