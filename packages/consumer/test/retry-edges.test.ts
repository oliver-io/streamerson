/**
 * Retry-mode edges (REQUEST_STREAM_RECEIPT.md §7): the retry gate covers ONLY
 * handler-threw — a no-handler is a config error retry can't fix and must be
 * dead-lettered immediately, on every intake path ('>' read AND self-drain).
 * Plus: the exact numeric semantics of `maxAttempts`, and the shared-PEL contract
 * of two live members constructed under the SAME groupMemberId (CG-B1 pin).
 *
 * Live Redis required. Run: bun test packages/consumer/test/retry-edges.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Topic } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, write, collectResponses, abandonToPhantom, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

function group(topic: Topic) { return `redge-${topic.topic}`; }

test('no-handler under retry is dead-lettered immediately (retry gate covers only handler-threw); PEL drains', async () => {
  const topic = rig.topic('redge-nohandler');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 500, retry: { maxAttempts: 3 }, eventMap: { echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'nh-1' },
  ));
  await member.connectAndListen();

  await write(admin, topic, 'mystery', 'nh-m1', { v: 1 });

  await until(async () => (await readDlq(admin, topic)).length === 1, 4000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('nh-m1');
  expect(dlq[0]?.reason).toBe('no-handler');           // not retried as handler-threw
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0); // terminalized, no forever-loop

  // Stability: past several reclaim intervals it was not re-run/re-dead-lettered.
  await sleep(1200);
  expect(await readDlq(admin, topic)).toHaveLength(1);
}, 30000);

test('no-handler through self-drain: a restarted member terminalizes its own pending unregistered-type entry (DLQ), no spin', async () => {
  const topic = rig.topic('redge-selfdrain');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  // Abandon an 'orphan'-typed entry in consumer sd-A's own PEL (raw XREADGROUP as
  // sd-A, never acked — a member that took the message and crashed).
  await abandonToPhantom(admin, topic, g, 'sd-m1', 'sd-A');
  expect(await pendingCount(admin, topic, g)).toBe(1);

  // The real member comes up under the SAME id with retry on but NO 'orphan' handler:
  // selfDrain must classify it no-handler and dead-letter it, not re-run forever.
  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 5000, retry: { maxAttempts: 3 }, eventMap: { echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'sd-A' },
  ));
  await member.connectAndListen();

  await until(async () => (await readDlq(admin, topic)).length === 1, 5000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('sd-m1');
  expect(dlq[0]?.reason).toBe('no-handler');
  expect(await pendingCount(admin, topic, g)).toBe(0);
}, 30000);

test('maxAttempts boundary: {maxAttempts: 2} runs the handler exactly twice, then DLQs with deliveryCount 3', async () => {
  const topic = rig.topic('redge-boundary');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });
  const counterKey = `${topic.consumerKey()}:runs`;
  rig.onTeardown(async () => { try { await admin.client.send('DEL', [counterKey]); } catch { /* */ } });

  const member = rig.track(new ConsumerGroupMember(
    {
      topic, redisConfiguration: REDIS, bidirectional: true, processingTimeout: 300, retry: { maxAttempts: 2 },
      eventMap: { boom: async () => { await admin.client.send('INCR', [counterKey]); throw new Error('always fails'); } },
    },
    { groupId: g, groupMemberId: 'mb-1' },
  ));
  await member.connectAndListen();

  await write(admin, topic, 'boom', 'mb-m1', { v: 1 });

  await until(async () => (await readDlq(admin, topic)).length === 1, 6000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('mb-m1');
  expect(dlq[0]?.reason).toBe('handler-threw');
  // Exact numeric contract: ran on deliveries 1 and 2; the 3rd delivery (count 3 >
  // maxAttempts 2) is poison → DLQ WITHOUT a handler run, recording that count.
  expect(dlq[0]?.deliveryCount).toBe('3');
  expect(Number(await admin.client.send('GET', [counterKey]))).toBe(2);
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);

  // Stability window (several reclaim intervals): it never ran a third time.
  await sleep(1000);
  expect(Number(await admin.client.send('GET', [counterKey]))).toBe(2);
}, 30000);

test('CG-B1 pin: two live members under the SAME groupMemberId share one consumer identity — every message answered exactly once', async () => {
  const topic = rig.topic('redge-twins');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  // Shared-PEL-by-design contract: Redis partitions deliveries by consumer NAME, so
  // two connections reading as 'twin-1' split the stream but each entry is delivered
  // to exactly one of them. Same-id twins are therefore safe for delivery-count
  // (no duplicates) — but they share one PEL, so a crash of either muddles the
  // other's self-recovery view. Pinned observed execution count: exactly N.
  let runs = 0;
  const opts = () => ({
    topic, redisConfiguration: REDIS, bidirectional: true,
    eventMap: { echo: async (e: any) => { runs++; return { ok: true, v: e.payload?.v }; } },
  });
  const a = rig.track(new ConsumerGroupMember(opts(), { groupId: g, groupMemberId: 'twin-1' }));
  const b = rig.track(new ConsumerGroupMember(opts(), { groupId: g, groupMemberId: 'twin-1' }));
  await a.connectAndListen();
  await b.connectAndListen();

  const N = 10;
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `tw-${i}`, { v: i });

  const seen = await collectResponses(topic, N, 8000);
  expect(seen.size).toBe(N);                            // all answered
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);  // all acked
  expect(runs).toBe(N);                                 // observed: exactly once each, no double execution
}, 30000);
