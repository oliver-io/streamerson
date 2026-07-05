/**
 * Consumer-group primitive edge cases (real Redis):
 *   (a) double-ack idempotence (XACK returns 1 then 0);
 *   (b) two groups on one stream each see every message once;
 *   (c) respondAndAck / deadLetterAndAck failure symmetry — when the Lua XADD
 *       fails (WRONGTYPE target), the XACK must NOT have happened either
 *       (neither effect applied: the atomicity contract's other half, CG-I6);
 *   (d) group-mode `last` is ignored — reads always use '>' (never-delivered),
 *       so a self-PEL entry is not redelivered through getReadStream.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { expectRejection } from '@streamerson/test-utils';
import { StreamingDataSource } from '../../../src';
import { Topic } from '../../../src/utils/topic';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 100;

let ds: StreamingDataSource;
let reader: StreamingDataSource;
const keys: string[] = [];

beforeAll(async () => {
  ds = new StreamingDataSource(REDIS);
  reader = new StreamingDataSource(REDIS);
  await Promise.all([ds.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { if (keys.length) await ds.client.send('DEL', keys); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await ds.disconnect(); } catch { /* teardown */ }
});

async function pendingTopic(tag: string) {
  const topic = new Topic({ namespace: 'itest', topic: `gpe-${tag}-${uniq()}` });
  const stream = topic.consumerKey();
  keys.push(stream, topic.producerKey(), topic.deadLetterKey());
  await ds.createConsumerGroup({ stream, groupId: 'g', cursor: '0' });
  await ds.writeToStream({
    outgoingStream: stream, incomingStream: topic.producerKey(),
    messageType: 'data' as MessageType, messageId: 'mid-1',
    message: JSON.stringify({ a: 1 }), sourceId: 'src',
  });
  const delivered = await ds.readGroupEntries(stream, 'g', 'm1', '>', 500);
  expect(delivered.length).toBe(1);
  return { topic, stream, entry: delivered[0] };
}

describe('consumer-group primitive edges', () => {
  test('(a) double ack is idempotent: 1 then 0', async () => {
    const { topic, entry } = await pendingTopic('ack');
    expect(await ds.markProcessedByGroup(topic, 'g', entry.streamMessageId!)).toBe(1);
    expect(await ds.markProcessedByGroup(topic, 'g', entry.streamMessageId!)).toBe(0);
  }, 10000);

  test('(b) two groups on one stream: each group receives every message once', async () => {
    const stream = `itest:gpe:twogroups:${uniq()}`;
    keys.push(stream);
    await ds.createConsumerGroup({ stream, groupId: 'G1', cursor: '0' });
    await ds.createConsumerGroup({ stream, groupId: 'G2', cursor: '0' });
    for (let i = 0; i < 3; i++) {
      await ds.writeToStream({
        outgoingStream: stream, incomingStream: undefined,
        messageType: 'data' as MessageType, messageId: `m-${i}`,
        message: JSON.stringify({}), sourceId: 'src',
      });
    }
    const g1 = await ds.readGroupEntries(stream, 'G1', 'c1', '>', 500);
    const g2 = await ds.readGroupEntries(stream, 'G2', 'c1', '>', 500);
    expect(g1.map((e) => e.messageId)).toEqual(['m-0', 'm-1', 'm-2']);
    expect(g2.map((e) => e.messageId)).toEqual(['m-0', 'm-1', 'm-2']);
    // Per-group delivery, once each: nothing further pending after ack-less second read.
    expect(await ds.readGroupEntries(stream, 'G1', 'c1', '>', 200)).toEqual([]);
    expect(await ds.readGroupEntries(stream, 'G2', 'c1', '>', 200)).toEqual([]);
  }, 10000);

  test('(c1) respondAndAck failure symmetry: WRONGTYPE response target → rejected, still pending, no response written', async () => {
    const { topic, stream, entry } = await pendingTopic('raa');
    // Pre-create the producer/response key as a plain string so the script's XADD
    // fails with WRONGTYPE. Lua runs XADD before XACK; the script aborts on the
    // XADD error, so the XACK never executes — neither effect applies.
    await ds.client.send('SET', [topic.producerKey(), 'not-a-stream']);

    await expectRejection(() => ds.respondAndAck({
      producerStream: topic.producerKey(), consumerStream: stream, groupId: 'g',
      streamMessageId: entry.streamMessageId!, messageId: entry.messageId, messageType: 'resp',
      messageSourceId: 'src', payload: JSON.stringify({ ok: true }),
    }), /.+/);

    // Request still in the PEL — the ack did not happen.
    const pending = await ds.pendingDetails(stream, 'g');
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(entry.streamMessageId!);
    // And no response entry exists: the key is still the plain string.
    expect(await ds.client.send('TYPE', [topic.producerKey()])).toBe('string');
  }, 10000);

  test('(c2) deadLetterAndAck failure symmetry: WRONGTYPE dead-letter target → rejected, still pending, no dead-letter written', async () => {
    const { topic, stream, entry } = await pendingTopic('dla');
    await ds.client.send('SET', [topic.deadLetterKey(), 'not-a-stream']);

    await expectRejection(() => ds.deadLetterAndAck({
      deadLetterStream: topic.deadLetterKey(), consumerStream: stream, groupId: 'g',
      streamMessageId: entry.streamMessageId!, messageId: entry.messageId, reason: 'boom',
      consumer: 'm1', deliveryCount: '1', payload: JSON.stringify({ a: 1 }), failedAt: String(Date.now()),
    }), /.+/);

    const pending = await ds.pendingDetails(stream, 'g');
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(entry.streamMessageId!);
    expect(await ds.client.send('TYPE', [topic.deadLetterKey()])).toBe('string');
  }, 10000);

  test("(d) group-mode getReadStream ignores `last`: reads use '>' — self-PEL entries are not redelivered", async () => {
    // Pin: blockingStreamBatchMap always passes '>' for group reads (self-PEL
    // recovery is opt-in via readGroupEntries('0'), not wired into this path).
    // So `last: '0'` here does NOT drain the member's pending entries.
    const { stream, entry } = await pendingTopic('lastignored'); // mid-1 is now in m1's PEL, unacked
    void entry;

    const rs = reader.getReadStream({
      stream, last: '0', blockingTimeout: BLOCK,
      consumerGroupInstanceConfig: { groupId: 'g', groupMemberId: 'm1' },
    });
    const got: string[] = [];
    rs.on('data', (ev: MappedStreamEvent) => got.push(ev.messageId));

    // Give the reader a couple of cycles: the PEL'd mid-1 must NOT arrive.
    await sleep(3 * BLOCK);
    expect(got).toEqual([]);

    // A never-delivered message DOES arrive through the same reader.
    await ds.writeToStream({
      outgoingStream: stream, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: 'mid-2',
      message: JSON.stringify({}), sourceId: 'src',
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !got.includes('mid-2')) await sleep(15);
    rs.destroy();

    expect(got).toEqual(['mid-2']); // only the new message; mid-1 never redelivered here
  }, 15000);
});
