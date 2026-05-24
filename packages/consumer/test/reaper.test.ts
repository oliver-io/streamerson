/**
 * Phase 3 (REQUEST_STREAM_RECEIPT.md §12, §6) — the reaper terminalizes abandonment.
 * Integration test against live Redis (`bun run start:redis`).
 *
 * Scenario: a message is delivered to a consumer that never acks (a crashed/stuck
 * member, simulated by a raw XREADGROUP from a phantom consumer that we then drop).
 * The coordinator's reaper must, once the entry is idle ≥ processingTimeout,
 * XAUTOCLAIM it and move it to the dead-letter stream exactly once, draining the PEL.
 *
 * Run: bun test packages/consumer/test/reaper.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, sleep, until, pendingCount, readDlq, abandonToPhantom, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('reaper');
const GROUP = 'reaper-group';
const GRACE = 300;
let coordinator: ConsumerGroupCoordinator | undefined;
rig.onTeardown(() => coordinator?.disconnect());

beforeAll(async () => {
  await rig.connect();
  coordinator = new ConsumerGroupCoordinator({ topic, redisConfiguration: REDIS }, { name: GROUP, count: 1, processingTimeout: GRACE });
  await coordinator.connectAndListen(); // connect + start reaper
  await coordinator.create();
});

afterAll(() => rig.teardown());

test('reaper moves an abandoned pending entry to the dead-letter stream exactly once and drains the PEL', async () => {
  // Produce one message and deliver it to a phantom consumer that never acks — it now
  // sits in that consumer's PEL, idle clock ticking.
  await abandonToPhantom(admin, topic, GROUP, 'r-orphan');
  expect(await pendingCount(admin, topic, GROUP)).toBe(1); // delivered, unacked

  // The reaper terminalizes it once idle ≥ grace.
  await until(async () => (await readDlq(admin, topic)).length === 1, 3000);
  const dlq = await readDlq(admin, topic);

  // Terminalized to the DLQ as 'abandoned', exactly once, and removed from the PEL.
  expect(dlq.length).toBe(1);
  expect(dlq[0]?.messageId).toBe('r-orphan');
  expect(dlq[0]?.reason).toBe('abandoned');
  await sleep(GRACE * 2);                              // stability: give later sweeps a window to misfire
  expect(await readDlq(admin, topic)).toHaveLength(1); // not re-dead-lettered on subsequent sweeps
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);
}, 20000);
