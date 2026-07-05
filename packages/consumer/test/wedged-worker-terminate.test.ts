/**
 * Gap 7 (TESTING_ANALYSIS consumer gaps) — wedged-worker force-terminate.
 *
 * A member whose handler is a synchronous busy-loop (`while(true){}`) never yields
 * its worker-thread event loop, so the coordinator's `drain` postMessage is never
 * seen worker-side. The safety net is main-thread-side: `drainMember` (src/cluster.ts)
 * arms a timer for `idleTimeout + DRAIN_TERMINATE_SLACK_MS (250)` and then
 * `worker.terminate()`s, so `cluster.stop()` must return within that budget plus
 * generous slack — never hang on a wedged member.
 *
 * The wedged entry was delivered (XREADGROUP) but never acked, so it must remain
 * pending in the PEL after the terminate — recoverable, never silently lost.
 * (processingTimeout is 0 here, so the coordinator reaper is disabled and cannot
 * move it to the DLQ; the PEL is the pinned resting place.)
 *
 * Live Redis required. Run: bun test packages/consumer/test/wedged-worker-terminate.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, until, pendingCount, write, xlen, testRig } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-wedge-member.ts');

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('wedge');
const GROUP = 'wedge-group';
const IDLE = 400; // drain budget; force-terminate fires at IDLE + 250

let cluster: ConsumerGroupCluster | undefined;
rig.onTeardown(async () => { try { await cluster?.stop(); } catch { /* */ } });

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('stop() force-terminates a wedged member within the drain budget and the entry stays pending', async () => {
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // processingTimeout 0: reaper off (group.ts startReaper no-ops) and no handler
    // budget wrap — the wedge is pure, and the entry's only exit is the PEL.
    { name: GROUP, count: 1, processingTimeout: 0, idleTimeout: IDLE },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  // Deliver one message; the handler wedges synchronously with the entry unacked.
  await write(admin, topic, 'wedge', 'wedge-1', { v: 1 });
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 1, 4000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(1);

  const t0 = Date.now();
  await cluster.stop();
  const elapsed = Date.now() - t0;
  // Budget verified against src/cluster.ts: drainMember timer = idleTimeout + 250,
  // then terminate. Generous slack for terminate + coordinator disconnect.
  expect(elapsed).toBeLessThan(IDLE + 250 + 2500);

  // Never silently lost: still pending in the PEL (no ack, no reaper), no response.
  expect(await pendingCount(admin, topic, GROUP)).toBe(1);
  expect(await xlen(admin, topic.producerKey())).toBe(0);
  expect(await xlen(admin, topic.deadLetterKey())).toBe(0);
}, 30000);
