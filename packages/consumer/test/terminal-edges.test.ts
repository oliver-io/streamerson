/**
 * Terminal-transition edges (REQUEST_STREAM_RECEIPT.md §5 receipt invariant): what
 * happens when the terminal step itself cannot complete — unserializable responses,
 * a broken producer key, a broken dead-letter key, undecodable payloads. Contract
 * under test: an entry leaves the PEL only via an atomic terminal transition, a
 * failed transition leaves it PENDING (recoverable, never silently dropped), and
 * the read loop always survives.
 *
 * Live Redis required. Run: bun test packages/consumer/test/terminal-edges.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Topic } from '@streamerson/core';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, readEntries, write, awaitResponse, xlen, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

function group(topic: Topic) { return `tedge-${topic.topic}`; }

/**
 * 🔴 KNOWN DEFECT (intended-contract RED). A handler returning `undefined` is within
 * the typed contract (`PayloadVariety | void`), but `JSON.stringify(undefined)` is the
 * JS value `undefined`, so respondAndAck passes a non-string arg to the Redis client:
 *   TypeError: Expected argument to be a string or buffer for 'sendCommand'.
 *     at evalScript (core/src/datasource/streamable.ts:478) ← respondAndAck (:496)
 *     at terminal (consumer/src/member.ts:248) ← listen (:140)
 * Product-vs-harness proven by that stack (probe run 2026-07-03 against live Redis):
 * the entry is neither acked nor terminalized — it wedges in the PEL forever with
 * retry off (no response, no DLQ). Intended contract: a void return terminalizes
 * (DONE). The loop DOES survive (next message round-trips) — that part passes.
 */
test('handler returning undefined must still terminalize the entry (currently wedges pending — RED)', async () => {
  const topic = rig.topic('tedge-undef');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { voidy: async () => undefined as any, echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'un-1' },
  ));
  await member.connectAndListen();

  await write(admin, topic, 'voidy', 'u-1', { v: 1 });
  // The loop survives the failed terminal transition: a subsequent message round-trips.
  await write(admin, topic, 'echo', 'u-2', { v: 2 });
  const got = await awaitResponse(topic, 'u-2', 5000);
  expect(got).toBeDefined();

  // Observed today: no response for u-1, no DLQ entry, and the entry stays pending.
  const responses = await readEntries(admin, topic.producerKey());
  expect(responses.filter((r) => r['messageId'] === 'u-1')).toHaveLength(0); // no (unparseable) response written
  expect(await readDlq(admin, topic)).toHaveLength(0);

  // Intended contract (FAILS — the defect): the entry reaches a terminal state.
  await until(async () => (await pendingCount(admin, topic, g)) === 0, 3000);
  expect(await pendingCount(admin, topic, g)).toBe(0);
}, 30000);

test('non-JSON-serializable response (bigint): terminal stringify throws, entry left PENDING, loop survives', async () => {
  const topic = rig.topic('tedge-bigint');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { big: async () => ({ n: 1n }) as any, echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'bi-1' },
  ));
  await member.connectAndListen();

  await write(admin, topic, 'big', 'b-1', { v: 1 });
  // member.terminal: JSON.stringify({n: 1n}) throws → caught by the listen loop →
  // "Terminal transition failed; entry left pending". Give it a real window, then pin.
  await until(async () => (await pendingCount(admin, topic, g)) === 1, 4000);
  expect(await pendingCount(admin, topic, g)).toBe(1);   // pending, not acked
  expect(await xlen(admin, topic.producerKey())).toBe(0); // no response
  expect(await readDlq(admin, topic)).toHaveLength(0);    // not dead-lettered

  // Loop alive: the NEXT message still processes.
  await write(admin, topic, 'echo', 'b-2', { v: 2 });
  const got = await awaitResponse(topic, 'b-2', 5000);
  expect(got).toBeDefined();
  expect(await pendingCount(admin, topic, g)).toBe(1);    // only the poison entry remains
}, 30000);

test('respondAndAck failure (WRONGTYPE producer key) leaves the entry pending; loop recovers after the key is fixed', async () => {
  const topic = rig.topic('tedge-wrongtype');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async (e: any) => ({ ok: true, v: e.payload?.v }) } },
    { groupId: g, groupMemberId: 'wt-1' },
  ));
  await member.connectAndListen();

  // Sabotage the producer key: the Lua XADD in respondAndAck now fails (WRONGTYPE).
  await admin.client.send('SET', [topic.producerKey(), 'bogus-string']);

  await write(admin, topic, 'echo', 'w-1', { v: 1 });
  await until(async () => (await pendingCount(admin, topic, g)) === 1, 4000);
  expect(await pendingCount(admin, topic, g)).toBe(1);  // receipt invariant: not acked
  expect(await readDlq(admin, topic)).toHaveLength(0);  // a terminal failure is not a handler failure

  // Fix the key; a subsequent message round-trips (loop survived the WRONGTYPE).
  await admin.client.send('DEL', [topic.producerKey()]);
  await write(admin, topic, 'echo', 'w-2', { v: 2 });
  const got = await awaitResponse(topic, 'w-2', 5000);
  expect(got).toBeDefined();
  // w-1 stays pending (retry off — no redelivery path in-process; reaper/retry territory).
  expect(await pendingCount(admin, topic, g)).toBe(1);
}, 30000);

test('malformed JSON request payload: skipped at decode (F3), stays PENDING (never dispatched), loop continues', async () => {
  const topic = rig.topic('tedge-badjson');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'mj-1' },
  ));
  await member.connectAndListen();

  // Raw request whose payload is not valid JSON but is marked messageProtocol=json.
  await admin.writeToStream({
    outgoingStream: topic.consumerKey(),
    incomingStream: topic.producerKey(),
    messageType: 'echo' as any,
    messageId: 'bad-1',
    message: '{broken',
    sourceId: 'test',
  });

  // Pinned classification: NOT handler-threw. parseStreamReply skips the undecodable
  // entry (streamable.ts F3 — "Skipping undecodable stream entry") BEFORE dispatch, so
  // it never reaches the handler or the DLQ; but XREADGROUP already delivered it, so it
  // sits in the PEL until a reaper/retry recovers it. Honest pin of the current contract.
  await until(async () => (await pendingCount(admin, topic, g)) === 1, 4000);
  expect(await pendingCount(admin, topic, g)).toBe(1);
  expect(await readDlq(admin, topic)).toHaveLength(0);

  // The loop continues: a well-formed message round-trips.
  await write(admin, topic, 'echo', 'good-1', { v: 1 });
  const got = await awaitResponse(topic, 'good-1', 5000);
  expect(got).toBeDefined();
  expect(await pendingCount(admin, topic, g)).toBe(1);  // only the undecodable entry remains
}, 30000);

test('DLQ write failure is not silent loss: entry remains PENDING (receipt invariant), member keeps serving', async () => {
  const topic = rig.topic('tedge-dlqfail');
  const g = group(topic);
  await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: g, cursor: '$' });

  const member = rig.track(new ConsumerGroupMember(
    { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async () => ({ ok: true }) } },
    { groupId: g, groupMemberId: 'df-1' },
  ));
  await member.connectAndListen();

  // Sabotage the dead-letter key: deadLetterAndAck's Lua XADD will fail (WRONGTYPE).
  await admin.client.send('SET', [topic.deadLetterKey(), 'bogus-string']);

  // Unregistered type → no-handler → dead-letter attempt → fails → entry left pending.
  await write(admin, topic, 'unregistered', 'd-1', { v: 1 });
  await until(async () => (await pendingCount(admin, topic, g)) === 1, 4000);
  expect(await pendingCount(admin, topic, g)).toBe(1);  // NOT acked — no silent loss

  // Member keeps serving.
  await write(admin, topic, 'echo', 'd-2', { v: 2 });
  const got = await awaitResponse(topic, 'd-2', 5000);
  expect(got).toBeDefined();

  // Fix the DLQ key. Pinned honestly: with retry OFF there is no in-process redelivery
  // of an already-delivered pending entry (self-drain/reclaim are retry-only; the
  // coordinator reaper is not attached here), so the entry STAYS pending — recoverable
  // by a reaper/retry deployment, not by this bare member. Stability window then assert.
  await admin.client.send('DEL', [topic.deadLetterKey()]);
  await sleep(800);
  expect(await pendingCount(admin, topic, g)).toBe(1);
  expect(await readDlq(admin, topic)).toHaveLength(0);
}, 30000);
