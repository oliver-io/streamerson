/**
 * P1-6 — the headline receipt invariant with a REAL crash (REQUEST_STREAM_RECEIPT.md §6).
 * Default mode: retry OFF, reaper ON. Integration test against live Redis.
 *
 * A cluster member (a real Bun Worker thread) takes a `boom` message into its PEL and
 * `process.exit(1)`s before acking — genuine thread death, not a phantom-consumer
 * simulation. The coordinator restarts the crashed member (same groupMemberId; retry is
 * off, so the restarted member does NOT self-drain and cannot race the reaper), and the
 * reaper terminalizes the abandoned entry to the DLQ exactly once, draining the PEL.
 *
 * Conservation asserted on Redis ground truth: every written messageId reaches the
 * response stream XOR the dead-letter stream.
 *
 * Run: bun test packages/consumer/test/reaper-real-crash.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, pendingCount, readDlq, readEntries, write, awaitResponse, testRig } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'reaper-crash-member.ts');
const GRACE = 500; // processingTimeout: reaper sweep interval AND idle threshold

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('reaper-crash');
let cluster: ConsumerGroupCluster | undefined;
rig.onTeardown(async () => { try { await cluster?.stop(); } catch { /* */ } });

beforeAll(async () => {
  await rig.connect();
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'reaper-crash-group', count: 1, processingTimeout: GRACE, idleTimeout: 300 },
    fileTarget,
  );
  await cluster.start();
});

afterAll(() => rig.teardown());

test('receipt invariant: a really-crashed member\'s pending entry is reaped to the DLQ exactly once; healthy work responded', async () => {
  const GROUP = 'reaper-crash-group';
  expect(cluster!.readyMembers).toBe(1);

  // Healthy message first: delivered, handled, responded (conservation baseline).
  await write(admin, topic, 'echo', 'ok-1', { hi: 'alive' });
  const ok = await awaitResponse(topic, 'ok-1', 8000);
  expect(ok).toBeDefined();
  expect((ok!.payload as any).echoed).toBe('alive');

  // Real crash: the worker thread takes `boom-1` into its PEL and process.exit(1)s
  // before any ack. Observe genuine thread death via the ready set dipping.
  await write(admin, topic, 'boom', 'boom-1', { die: true });
  expect(await until(() => cluster!.readyMembers < 1, 8000)).toBe(true);

  // The entry is abandoned: delivered (in the PEL), no ack, its consumer is dead.
  expect(await until(async () => (await pendingCount(admin, topic, GROUP)) === 1, 4000)).toBe(true);

  // The coordinator restarts the member (same groupMemberId). Retry is OFF, so the
  // restarted member does not self-drain its PEL — the abandoned entry stays put
  // until the reaper's idle >= GRACE sweep terminalizes it.
  await until(() => cluster!.readyMembers === 1, 10000);
  expect(cluster!.readyMembers).toBe(1);

  // Reaper terminalizes: swept to the DLQ with cause 'abandoned', PEL drained.
  expect(await until(async () => (await readDlq(admin, topic)).length >= 1, 8000)).toBe(true);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('boom-1');
  expect(dlq[0]?.reason).toBe('abandoned');
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 4000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);

  // Exactly once: give two further sweep intervals a window to double-fire, then
  // re-assert (bounded negative-stability window).
  await sleep(GRACE * 2);
  expect(await readDlq(admin, topic)).toHaveLength(1);

  // Conservation over every written messageId: response XOR DLQ.
  const responses = (await readEntries(admin, topic.producerKey())).map((f) => f.messageId);
  expect(responses).toContain('ok-1');           // healthy -> responded
  expect(responses).not.toContain('boom-1');     // crashed -> never responded
  expect(new Set(responses).size).toBe(responses.length); // no duplicate responses
  expect(dlq.map((f) => f.messageId)).not.toContain('ok-1'); // responded -> not dead-lettered
}, 40000);
