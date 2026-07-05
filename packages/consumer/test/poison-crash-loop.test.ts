/**
 * The hard-poison story (cluster restart x retry composition): a message whose
 * handler hard-kills the worker thread. The crash leaves the entry pending; the
 * cluster restarts the member under the SAME id; selfDrain redelivers the poison
 * (bumping its delivery count) and it crashes again — until the count exceeds
 * retry.maxAttempts, at which point the restarted member's selfDrain dead-letters
 * it WITHOUT running the handler (no further crash), and normal traffic resumes.
 * Convergence is the contract: a hard poison must not crash-loop forever.
 *
 * Live Redis required. Run: bun test packages/consumer/test/poison-crash-loop.test.ts
 */
import { test, expect, afterEach } from 'bun:test';
import path from 'path';
import { StreamingDataSource, Topic } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, pendingCount, readDlq, write, collectResponses, makeTopic } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-poison-crash-member.ts');

let cluster: ConsumerGroupCluster | undefined;
let topic: Topic | undefined;
let counterKey: string | undefined;
const admin = new StreamingDataSource(REDIS);
let adminConnected = false;

afterEach(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  cluster = undefined;
  await sleep(100);
  if (adminConnected) {
    if (topic) { try { await admin.client.send('DEL', [topic.consumerKey(), topic.producerKey(), topic.deadLetterKey()]); } catch { /* */ } }
    if (counterKey) { try { await admin.client.send('DEL', [`${counterKey}:spawns`, `${counterKey}:poison-runs`]); } catch { /* */ } }
  }
  topic = undefined;
});

test('hard poison converges: crash -> restart -> selfDrain redelivery until maxAttempts, then DLQ without a handler run; echoes answered', async () => {
  if (!adminConnected) { await admin.connect(); adminConnected = true; }
  topic = makeTopic('poison-loop');
  counterKey = `${topic.consumerKey()}:fixture`;
  process.env['POISON_FIXTURE_KEY'] = counterKey;   // inherited by the worker threads

  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // retry on => the coordinator reaper stays OFF (members own recovery); small
    // grace keeps reclaim responsive, small idleTimeout keeps drains snappy.
    { name: 'poison-group', count: 1, processingTimeout: 500, idleTimeout: 300, retry: { maxAttempts: 2 } },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  await write(admin, topic, 'work', 'poison-1', { poison: true });
  await write(admin, topic, 'work', 'echo-1', { hi: 1 });
  await write(admin, topic, 'work', 'echo-2', { hi: 2 });

  const runs = async () => Number((await admin.client.send('GET', [`${counterKey}:poison-runs`])) ?? 0);

  // Convergence: the poison ends up in the DLQ with deliveryCount > maxAttempts.
  // (Restart backoff doubles per crash — 100ms, 200ms — so this is quick, but the
  // cap is generous.) If this times out, the crash loop did not converge: that is
  // the RED signal — prove via the spawn/poison-run counters below.
  const converged = await until(async () => (await readDlq(admin, topic!)).length >= 1, 35_000, 100);
  if (!converged) {
    // Evidence for a non-convergence defect report (bounded observation, not a hang):
    console.error('poison-crash-loop DID NOT CONVERGE', {
      spawns: Number((await admin.client.send('GET', [`${counterKey}:spawns`])) ?? 0),
      poisonRuns: await runs(),
    });
  }
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('poison-1');
  expect(dlq[0]?.reason).toBe('handler-threw');
  expect(Number(dlq[0]?.deliveryCount)).toBeGreaterThan(2);   // exceeded maxAttempts

  // The handler ran (crashed) on deliveries within the cap only — the final selfDrain
  // dead-lettered WITHOUT running it (else it would have crashed instead of DLQing).
  expect(await runs()).toBeGreaterThanOrEqual(1);
  expect(await runs()).toBeLessThanOrEqual(2);

  // Normal traffic ultimately answered, pool healthy, PEL clean.
  const seen = await collectResponses(topic, 2, 15_000);
  expect(seen.has('echo-1')).toBe(true);
  expect(seen.has('echo-2')).toBe(true);
  await until(() => cluster!.readyMembers === 1, 10_000);
  expect(cluster.readyMembers).toBe(1);
  await until(async () => (await pendingCount(admin, topic!, 'poison-group')) === 0, 5000);
  expect(await pendingCount(admin, topic, 'poison-group')).toBe(0);

  // Stability: no further crashes/runs after convergence.
  const runsAfter = await runs();
  await sleep(1200);
  expect(await runs()).toBe(runsAfter);
}, 60_000);
