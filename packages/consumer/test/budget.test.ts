/**
 * Handler time budget (`processingTimeout`). A cluster member wraps each handler
 * (cluster-member.ts › wrapHandlers) in a `processingTimeout` race: a handler that
 * overruns is rejected, so the message is dispatched as handler-threw and — with no
 * retry — dead-lettered. The member is not left hung, and the loop survives to answer
 * the next message. Live Redis required (`bun run start:redis`).
 *
 * The budget is a worker concern (a bare ConsumerGroupMember runs handlers unwrapped),
 * so this drives the real cluster + worker fixture.
 *
 * Run: bun test packages/consumer/test/budget.test.ts
 */
import { test, expect, afterAll } from 'bun:test';
import path from 'path';
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, until, makeTopic, readDlq, write, awaitResponse, cleanupKeys } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');
const topic = makeTopic('budget');

const admin = new StreamingDataSource(REDIS);
let cluster: ConsumerGroupCluster | undefined;

afterAll(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  await sleep(150);
  await cleanupKeys(admin, topic);
  try { await admin.disconnect(); } catch { /* */ }
});

test('a handler exceeding processingTimeout is dead-lettered (handler-threw) and the loop survives', async () => {
  await admin.connect();
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'budget-group', count: 1, processingTimeout: 200, idleTimeout: 500 },
    fileTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  // The `slow` handler sleeps 1500ms, but the budget is 200ms → killed → handler-threw.
  await write(admin, topic, 'slow', 'budget-slow', { ms: 1500 });

  // It reaches the DLQ as handler-threw — the only reason the inline budget path emits
  // (the reaper would say 'abandoned'; a missing handler 'no-handler').
  await until(async () => (await readDlq(admin, topic)).some((e) => e.messageId === 'budget-slow' && e.reason === 'handler-threw'), 6000);
  const slow = (await readDlq(admin, topic)).filter((e) => e.messageId === 'budget-slow');
  expect(slow.some((e) => e.reason === 'handler-threw')).toBe(true);

  // The member survived the timeout: a later echo is still handled and answered.
  await write(admin, topic, 'echo', 'budget-echo', { hi: 'alive' });
  const got = await awaitResponse(topic, 'budget-echo', 5000);
  expect(got).toBeDefined();
  expect(got!.payload).toEqual({ ok: true, echoed: 'alive' });
}, 30000);
