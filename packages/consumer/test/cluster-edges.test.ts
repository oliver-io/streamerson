/**
 * Cluster edges: scale-to-zero (drain everything, queue a backlog, come back),
 * scale() argument validation leaving the pool untouched, the worker-side
 * processingTimeout budget rescuing a never-settling handler, and the inertness
 * of coordinator->worker protocol violations posted straight at a real Worker.
 *
 * Live Redis required. Run: bun test packages/consumer/test/cluster-edges.test.ts
 */
import { test, expect, afterEach } from 'bun:test';
import path from 'path';
import { pathToFileURL } from 'url';
import { StreamingDataSource, Topic } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import type { ClusterCommand, MemberSignal } from '../src/cluster-protocol';
import { REDIS, sleep, until, pendingCount, readDlq, readEntries, write, awaitResponse, collectResponses, xlen, consumerNames, makeTopic } from './harness';

const echoTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');
const hangTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-hang-member.ts');

let cluster: ConsumerGroupCluster | undefined;
let topic: Topic | undefined;
const admin = new StreamingDataSource(REDIS);
let adminConnected = false;

async function ensureAdmin() { if (!adminConnected) { await admin.connect(); adminConnected = true; } }

afterEach(async () => {
  try { await cluster?.stop(); } catch { /* */ }
  cluster = undefined;
  await sleep(100);
  if (topic && adminConnected) {
    try { await admin.client.send('DEL', [topic.consumerKey(), topic.producerKey(), topic.deadLetterKey()]); } catch { /* */ }
  }
  topic = undefined;
});

test('scale(0) drains all members with no respawn; a backlog queues and is answered after scale(2)', async () => {
  await ensureAdmin();
  topic = makeTopic('cedge-zero');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'zero-group', count: 1, processingTimeout: 5000, idleTimeout: 400 },
    echoTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  await cluster.scale(0);
  expect(cluster.members).toBe(0);
  // Stability window (>> 2x the 100ms restart base backoff): a drained member is
  // intentional teardown, never respawned toward a desiredCount of 0.
  await sleep(600);
  expect(cluster.members).toBe(0);

  // Backlog queues while nobody consumes...
  const N = 5;
  for (let i = 0; i < N; i++) await write(admin, topic, 'echo', `z-${i}`, { hi: i });
  await sleep(300);
  expect(await xlen(admin, topic.producerKey())).toBe(0);          // nothing answered
  expect(await xlen(admin, topic.consumerKey())).toBe(N);          // everything queued

  // ...and every queued message is answered after scaling back up.
  await cluster.scale(2);
  expect(cluster.readyMembers).toBe(2);
  const seen = await collectResponses(topic, N, 8000);
  expect(seen.size).toBe(N);
  await until(async () => (await pendingCount(admin, topic!, 'zero-group')) === 0, 3000);
  expect(await pendingCount(admin, topic, 'zero-group')).toBe(0);
}, 30000);

test('scale(-1) and scale(1.5) reject and leave the pool serving', async () => {
  await ensureAdmin();
  topic = makeTopic('cedge-badscale');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'badscale-group', count: 1, processingTimeout: 2000, idleTimeout: 400 },
    echoTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  await expect(cluster.scale(-1)).rejects.toThrow('non-negative integer');
  await expect(cluster.scale(1.5)).rejects.toThrow('non-negative integer');
  expect(cluster.count).toBe(1);      // desired count untouched by the rejected calls
  expect(cluster.members).toBe(1);

  // The pool still serves.
  await write(admin, topic, 'echo', 'bs-1', { hi: 'alive' });
  const got = await awaitResponse(topic, 'bs-1', 5000);
  expect(got).toBeDefined();
}, 30000);

test('a never-settling handler is cut off by the processingTimeout budget (DLQ handler-threw) and the member keeps serving', async () => {
  await ensureAdmin();
  topic = makeTopic('cedge-hang');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    // retry OFF; ~400ms budget. The worker-side wrapHandlers race rejects the hang,
    // which the member classifies handler-threw -> immediate DLQ (at-most-once path).
    { name: 'hang-group', count: 1, processingTimeout: 400, idleTimeout: 400 },
    hangTarget,
  );
  await cluster.start();
  expect(cluster.readyMembers).toBe(1);

  await write(admin, topic, 'hang', 'h-1', { v: 1 });
  await until(async () => (await readDlq(admin, topic!)).length === 1, 5000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('h-1');
  expect(dlq[0]?.reason).toBe('handler-threw');   // the budget rejection, not a reaper 'abandoned'

  // The member (same worker, un-wedged by the settled race) continues serving.
  await write(admin, topic, 'echo', 'h-2', { hi: 'after' });
  const got = await awaitResponse(topic, 'h-2', 5000);
  expect(got).toBeDefined();
  expect(await pendingCount(admin, topic, 'hang-group')).toBe(0);
}, 30000);

test('postMessage protocol violations (null, bogus, duplicate start) are inert: one consumer identity, one response per message', async () => {
  await ensureAdmin();
  topic = makeTopic('cedge-proto');
  const g = 'proto-group';
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  // Drive the real worker entry directly, exactly as cluster.ts constructs it.
  const worker = new Worker(pathToFileURL(echoTarget).href, { ref: true });
  try {
    const params = {
      connectionSettings: {
        topic: { namespace: topic.namespace, topic: topic.topic, mode: topic.mode },
        redisConfiguration: { host: REDIS.host, port: REDIS.port },
        bidirectional: true,
        blockTimeout: 100,
        prefetch: 1,
        processingTimeout: 0,
      },
      memberSettings: { groupId: g, groupMemberId: 'pv-1' },
      processingTimeout: 0,
      idleTimeout: 300,
    };
    let readies = 0;
    worker.addEventListener('message', (event: MessageEvent) => {
      if ((event.data as MemberSignal)?.type === 'ready') readies++;
    });

    // Violations before start are ignored (runClusterMember: null -> early return,
    // unknown type -> no branch).
    worker.postMessage(null);
    worker.postMessage({ type: 'bogus' });
    worker.postMessage({ type: 'start', params } as ClusterCommand);
    await until(() => readies >= 1, 5000);
    expect(readies).toBe(1);

    // Duplicate start. Pinned observed behavior: runClusterMember has no started-guard,
    // so a second 'start' builds a SECOND member instance (second ready, second
    // connection) — but both read as consumer 'pv-1', and Redis delivers each entry to
    // exactly one connection of a named consumer, so there is no duplicate delivery or
    // doubled response. Inert at the delivery contract; wasteful at the connection level.
    worker.postMessage({ type: 'start', params } as ClusterCommand);
    await sleep(500);
    expect(readies).toBe(2);   // pinned: the duplicate start DID build+ready a second member instance

    await write(admin, topic, 'echo', 'pv-m1', { hi: 'x' });
    const got = await awaitResponse(topic, 'pv-m1', 5000);
    expect(got).toBeDefined();

    // Exactly ONE consumer identity in the group, and no doubled response.
    const consumers = await admin.client.send('XINFO', ['CONSUMERS', topic.consumerKey(), g]);
    const names = consumerNames(consumers).filter((n) => n === 'pv-1');
    expect(names).toHaveLength(1);
    const responses = (await readEntries(admin, topic.producerKey())).filter((r) => r['messageId'] === 'pv-m1');
    expect(responses).toHaveLength(1);
  } finally {
    worker.terminate();
  }
}, 30000);
