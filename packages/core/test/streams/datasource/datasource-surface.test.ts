/**
 * StreamingDataSource — full surface integration test (real Redis).
 *
 * Exercises the datasource primitives directly at the core level so `streamable.ts` is
 * self-validated by core's own suite rather than only transitively via the consumer
 * package: KV (get/set/incr + error paths), `setResponseType`/`hasStreamId`, the
 * consumer-group lifecycle (`createConsumerGroup`/`createGroupMember`), the atomic
 * terminal-transition Lua ops (`respondAndAck`/`deadLetterAndAck`, incl. the EVAL
 * fallback after SCRIPT FLUSH), `claimStale`, `readGroupEntries` (`'>'` and `'0'`),
 * and `pendingDetails`. This is the coverage backbone for the 100% gate on streamable.ts.
 *
 * Real Redis required (`bun run start:redis`).
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

let ds: StreamingDataSource;        // controllable (has a control connection)
let nonCtrl: StreamingDataSource;   // controllable:false → control_or_client falls back to client

beforeAll(async () => {
  ds = new StreamingDataSource(REDIS);
  nonCtrl = new StreamingDataSource({ ...REDIS, controllable: false });
  await Promise.all([ds.connect(), nonCtrl.connect()]);
});
afterAll(async () => {
  try { await ds.disconnect(); } catch { /* */ }
  try { await nonCtrl.disconnect(); } catch { /* */ }
});

async function rows(key: string): Promise<Array<Record<string, string>>> {
  const reply = (await ds.client.send('XRANGE', [key, '-', '+'])) as Array<[string, string[]]>;
  return (reply ?? []).map(([id, kv]) => { const f: Record<string, string> = { _id: id }; for (let i = 0; i + 1 < kv.length; i += 2) f[kv[i]] = kv[i + 1]; return f; });
}

// Redis-op rejections are asserted with `expectRejection` (from @streamerson/test-utils),
// NOT bun's `expect().rejects` — the latter wedges an in-flight Bun.RedisClient command's
// connection (Bun 1.3.13 known bug; see that helper's doc + the bunbug/ repro).

describe('StreamingDataSource — KV and small accessors', () => {
  test('get/set round-trip, missing key, and empty-set guard', async () => {
    const key = `itest:kv:${uniq()}`;
    expect(await ds.set({ key }, 'hello')).toBe(true);
    expect(await ds.get(key)).toBe('hello');
    expect(await ds.get(`itest:kv:missing:${uniq()}`)).toBeUndefined();
    // Empty value is rejected (the guard's inner throw is re-wrapped as 'Failed SET').
    await expectRejection(() => ds.set({ key }, ''), /Failed SET/);
    await ds.client.send('DEL', [key]);
  });

  test('incr increments', async () => {
    const key = `itest:incr:${uniq()}`;
    expect(Number(await ds.incr(key))).toBe(1);
    expect(Number(await ds.incr(key))).toBe(2);
    await ds.client.send('DEL', [key]);
  });

  test('get/incr surface Redis errors (WRONGTYPE / non-integer)', async () => {
    const streamKey = `itest:wrongtype:${uniq()}`;
    await ds.writeToStream({ outgoingStream: streamKey, incomingStream: undefined, messageType: 'data' as MessageType, messageId: 'm', message: JSON.stringify({}), sourceId: 's' });
    await expectRejection(() => ds.get(streamKey), /Failed GET/);   // GET on a stream → WRONGTYPE
    const strKey = `itest:nonint:${uniq()}`;
    await ds.set({ key: strKey }, 'not-a-number');
    await expectRejection(() => ds.incr(strKey), /Failed INCR/);    // INCR on a non-integer
    await ds.client.send('DEL', [streamKey, strKey]);
  });

  test('setResponseType and hasStreamId', () => {
    const fresh = new StreamingDataSource(REDIS);
    fresh.setResponseType('xfer');
    expect(fresh.responseType).toBe('xfer' as MessageType);
    expect(fresh.hasStreamId('nope')).toBe(false);
    fresh.addStreamId('k1');
    expect(fresh.hasStreamId('k1')).toBe(true);
    fresh.removeStreamId('k1');
    expect(fresh.hasStreamId('k1')).toBe(false);
  });

  test('debugPing', async () => {
    expect(await ds.debugPing()).toBe('PONG');
  });
});

describe('StreamingDataSource — consumer-group lifecycle', () => {
  test('createConsumerGroup is idempotent (BUSYGROUP) and surfaces non-BUSYGROUP errors', async () => {
    const topic = new Topic({ namespace: 'itest', topic: `cg-${uniq()}` });
    const stream = topic.consumerKey();
    await ds.createConsumerGroup({ stream, groupId: 'g', cursor: '0' });
    expect(await ds.createConsumerGroup({ stream, groupId: 'g', cursor: '0' })).toBe('BUSYGROUP');
    // XGROUP CREATECONSUMER returns 1 when the consumer was created, 0 if it already existed.
    expect(await ds.createGroupMember({ stream, groupId: 'g', groupMemberId: 'm1' })).toBe(1);
    expect(await ds.createGroupMember({ stream, groupId: 'g', groupMemberId: 'm1' })).toBe(0);

    // A non-BUSYGROUP failure (string key → WRONGTYPE) must propagate, not be swallowed.
    const strKey = `itest:cg-wrong:${uniq()}`;
    await ds.set({ key: strKey }, 'x');
    await expectRejection(() => ds.createConsumerGroup({ stream: strKey, groupId: 'g', cursor: '0' }), /.+/);
    await ds.client.send('DEL', [stream, strKey]);
  });
});

describe('StreamingDataSource — atomic terminal transitions + claim/pending', () => {
  async function setupGroupWithDeliveredEntry(member: string) {
    const topic = new Topic({ namespace: 'itest', topic: `atomic-${uniq()}` });
    const stream = topic.consumerKey();
    const group = 'g';
    await ds.createConsumerGroup({ stream, groupId: group, cursor: '0' });
    await ds.writeToStream({ outgoingStream: stream, incomingStream: topic.producerKey(), messageType: 'data' as MessageType, messageId: 'mid-1', message: JSON.stringify({ a: 1 }), sourceId: 'src' });
    const delivered = await ds.readGroupEntries(stream, group, member, '>', 500);
    return { topic, stream, group, delivered };
  }

  test('respondAndAck atomically writes the response and acks the request', async () => {
    const { topic, stream, group, delivered } = await setupGroupWithDeliveredEntry('m1');
    expect(delivered.length).toBe(1);
    const e = delivered[0];

    await ds.respondAndAck({
      producerStream: topic.producerKey(), consumerStream: stream, groupId: group,
      streamMessageId: e.streamMessageId!, messageId: e.messageId, messageType: 'resp',
      messageSourceId: 'src', payload: JSON.stringify({ ok: true }),
    });

    const responses = await rows(topic.producerKey());
    expect(responses.some((r) => r['messageId'] === 'mid-1')).toBe(true);
    expect((await ds.pendingDetails(stream, group)).length).toBe(0); // acked → PEL empty
    await ds.client.send('DEL', [stream, topic.producerKey()]);
  });

  test('deadLetterAndAck atomically dead-letters and acks', async () => {
    const { topic, stream, group, delivered } = await setupGroupWithDeliveredEntry('m1');
    const e = delivered[0];

    await ds.deadLetterAndAck({
      deadLetterStream: topic.deadLetterKey(), consumerStream: stream, groupId: group,
      streamMessageId: e.streamMessageId!, messageId: e.messageId, reason: 'boom', consumer: 'm1',
      deliveryCount: '1', payload: JSON.stringify({ a: 1 }), failedAt: String(Date.now()),
    });

    const dlq = await rows(topic.deadLetterKey());
    expect(dlq.some((r) => r['messageId'] === 'mid-1' && r['reason'] === 'boom')).toBe(true);
    expect((await ds.pendingDetails(stream, group)).length).toBe(0);
    await ds.client.send('DEL', [stream, topic.deadLetterKey()]);
  });

  test('atomic transitions fall back to EVAL after SCRIPT FLUSH (NOSCRIPT)', async () => {
    const { topic, stream, group, delivered } = await setupGroupWithDeliveredEntry('m1');
    const e = delivered[0];
    await ds.client.send('SCRIPT', ['FLUSH']); // invalidate cached SHAs → EVALSHA NOSCRIPT → EVAL fallback

    await ds.respondAndAck({
      producerStream: topic.producerKey(), consumerStream: stream, groupId: group,
      streamMessageId: e.streamMessageId!, messageId: e.messageId, messageType: 'resp',
      messageSourceId: 'src', payload: JSON.stringify({ ok: true }),
    });
    expect((await rows(topic.producerKey())).some((r) => r['messageId'] === 'mid-1')).toBe(true);
    expect((await ds.pendingDetails(stream, group)).length).toBe(0);
    await ds.client.send('DEL', [stream, topic.producerKey()]);
  });

  test('readGroupEntries("0") returns the consumer PEL; claimStale reclaims an idle entry', async () => {
    const { stream, group, delivered } = await setupGroupWithDeliveredEntry('mA');
    const e = delivered[0];

    // Self-PEL read ('0') returns mA's delivered-unacked entry.
    const pel = await ds.readGroupEntries(stream, group, 'mA', '0', 200);
    expect(pel.some((x) => x.messageId === 'mid-1')).toBe(true);

    // pendingDetails scoped to one consumer. Delivery count is numeric: one '>'
    // delivery plus one '0' PEL re-read (which bumps the count) → 2.
    const detailsA = await ds.pendingDetails(stream, group, 100, 'mA');
    expect(detailsA.length).toBe(1);
    expect(detailsA[0].consumer).toBe('mA');
    expect(detailsA[0].deliveryCount).toBe(2);

    // claimStale moves the (idle ≥ 0ms) entry to mB; XAUTOCLAIM bumps delivery count again → 3.
    const claimed = await ds.claimStale(stream, group, 'mB', 0);
    expect(claimed.entries.some((x) => x.messageId === 'mid-1')).toBe(true);
    const detailsB = await ds.pendingDetails(stream, group, 100, 'mB');
    expect(detailsB.length).toBe(1);
    expect(detailsB[0].deliveryCount).toBe(3);
    void e;
    await ds.client.send('DEL', [stream]);
  });

  test('control_or_client falls back to the data connection when not controllable', async () => {
    const topic = new Topic({ namespace: 'itest', topic: `noctrl-${uniq()}` });
    const stream = topic.consumerKey();
    await nonCtrl.createConsumerGroup({ stream, groupId: 'g', cursor: '0' });
    await nonCtrl.writeToStream({ outgoingStream: stream, incomingStream: undefined, messageType: 'data' as MessageType, messageId: 'n-1', message: JSON.stringify({}), sourceId: 's' });
    const delivered = await nonCtrl.readGroupEntries(stream, 'g', 'm', '>', 500);
    // pendingDetails / markProcessedByGroup route through control_or_client → client here.
    expect((await nonCtrl.pendingDetails(stream, 'g')).length).toBe(1);
    // markProcessedByGroup acks by the Redis stream entry id (not the app messageId).
    expect(typeof await nonCtrl.markProcessedByGroup(topic, 'g', delivered[0].streamMessageId!)).toBe('number');
    expect((await nonCtrl.pendingDetails(stream, 'g')).length).toBe(0);
    await nonCtrl.client.send('DEL', [stream]);
  });
});
