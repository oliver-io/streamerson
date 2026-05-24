/**
 * Reaper enable/disable policy + NOGROUP tolerance (group.ts › startReaper / sweep).
 * Complements reaper.test.ts (which proves the reaper DOES terminalize an abandoned
 * entry, exactly once). Here we pin when it must NOT run, and that a sweep started
 * before the group exists is tolerant. Integration test against live Redis.
 *
 * Contract pinned here:
 *  - startReaper is a no-op when processingTimeout = 0 (no abandonment grace ⇒ no safe
 *    idle threshold), so an abandoned entry is left pending, never dead-lettered;
 *  - startReaper is a no-op when `retry` is on — members reclaim-and-re-run abandoned
 *    entries themselves, so the coordinator must NOT also dead-letter them (no double
 *    terminalization);
 *  - sweep tolerates NOGROUP (group/stream not created yet): it swallows the error,
 *    keeps running, and reaps once the group + an abandoned entry exist.
 *
 * Run: bun test packages/consumer/test/reaper-policy.test.ts
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, sleep, until, pendingCount, readDlq, abandonToPhantom, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

describe('reaper policy', () => {
  test('disabled when processingTimeout = 0: an abandoned entry is left pending, never dead-lettered', async () => {
    const topic = rig.topic('reaperoff-grace0');
    const GROUP = 'grace0-group';
    const coordinator = rig.track(new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1, processingTimeout: 0 }));
    await coordinator.connectAndListen();   // startReaper is a no-op (grace = 0)
    await coordinator.create();

    await abandonToPhantom(admin, topic, GROUP, 'g0-orphan');
    expect(await pendingCount(admin, topic, GROUP)).toBe(1);

    // Negative/stability: give a (would-be) reaper several intervals to misfire, then
    // assert it never moved the entry. A real wait is correct for a "did not happen" check.
    await sleep(700);
    expect(await readDlq(admin, topic)).toHaveLength(0);     // never dead-lettered
    expect(await pendingCount(admin, topic, GROUP)).toBe(1); // still pending, recoverable
  }, 20000);

  test('disabled when retry is on: the coordinator does not dead-letter (members own reclaim)', async () => {
    const topic = rig.topic('reaperoff-retry');
    const GROUP = 'retry-reaper-group';
    // grace > 0 (would normally arm the reaper) BUT retry on ⇒ reaper stays off.
    const coordinator = rig.track(new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1, processingTimeout: 300, retry: { maxAttempts: 3 } }));
    await coordinator.connectAndListen();
    await coordinator.create();

    await abandonToPhantom(admin, topic, GROUP, 'rt-orphan');
    expect(await pendingCount(admin, topic, GROUP)).toBe(1);

    // > 2 grace intervals: had the coordinator's reaper run, it would have dead-lettered
    // this by now. It must not (a member's reclaim owns it). Stability wait.
    await sleep(800);
    expect(await readDlq(admin, topic)).toHaveLength(0);
    expect(await pendingCount(admin, topic, GROUP)).toBe(1);
  }, 20000);

  test('sweep tolerates NOGROUP (started before the group exists) and reaps once it does', async () => {
    const topic = rig.topic('reaper-nogroup');
    const GROUP = 'nogroup-then-group';
    const coordinator = rig.track(new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1, processingTimeout: 300 }));

    // Reaper armed BEFORE the group/stream exist: every sweep hits NOGROUP and must
    // swallow it without crashing the loop.
    await coordinator.connectAndListen();
    await sleep(700); // a couple of sweep intervals fire against a missing group (NOGROUP, swallowed)

    // Now the group exists and an entry is abandoned — the still-running reaper reaps it,
    // proving the loop survived the NOGROUP passes and resumed working.
    await coordinator.create();
    await abandonToPhantom(admin, topic, GROUP, 'ng-orphan');

    await until(async () => (await readDlq(admin, topic)).length === 1, 4000);
    const dlq = await readDlq(admin, topic);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.messageId).toBe('ng-orphan');
    expect(dlq[0]?.reason).toBe('abandoned');
    await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
    expect(await pendingCount(admin, topic, GROUP)).toBe(0);
  }, 20000);
});
