/**
 * Integration test (per dev principle: integration over unit). Exercises the
 * real code path of the Bun-native StreamingDataSource against a live Redis:
 * create group -> write -> blocking group read via the public Readable ->
 * decode -> ack. Requires Redis on localhost:6379 (`bun run start:redis`).
 *
 * Run: bun test packages/core/test/streams/datasource/bun-group-roundtrip.test.ts
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource } from '../../../src/datasource/streamable';
import { Topic } from '../../../src/utils/topic';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const topic = new Topic({ namespace: 'itest', topic: `roundtrip-${Date.now()}` });
const groupId = 'itest-group';
const memberId = 'itest-member';

const reader = new StreamingDataSource(REDIS);
const writer = new StreamingDataSource(REDIS);

afterAll(async () => {
  // Stop the reader's poll loop and close its connection *before* deleting the
  // stream, so an in-flight XREADGROUP can't race a DEL and log a NOGROUP.
  try { reader.abort(); } catch { /* ignore */ }
  // Let any read-ahead poll (<= one BLOCK interval) resolve before we close the
  // connection, so teardown doesn't cut an in-flight XREADGROUP.
  await new Promise((r) => setTimeout(r, 150));
  try { await reader.disconnect(); } catch { /* ignore */ }
  try { await writer.client.send('DEL', [topic.consumerKey()]); } catch { /* ignore */ }
  try { await writer.disconnect(); } catch { /* ignore */ }
});

test('consumer-group round-trip: create, write, blocking group-read, decode, ack', async () => {
  await Promise.all([reader.connect(), writer.connect()]);

  // Create the group at '$' (delivers only messages added after creation).
  await reader.createConsumerGroup({ stream: topic.consumerKey(), groupId });

  // Write one message after group creation so a '>' group read delivers it.
  await writer.writeToStream({
    outgoingStream: topic.consumerKey(),
    incomingStream: topic.producerKey(),
    messageType: 'test' as MessageType,
    messageId: 'm1',
    message: JSON.stringify({ hi: 'there' }),
    sourceId: 's1',
  });

  // Read it back through the public Readable: this drives iterateStream ->
  // blockingStreamBatchMap -> readAsGroup -> parseStreamReply.
  const stream = reader.getReadStream({
    stream: topic.consumerKey(),
    consumerGroupInstanceConfig: { groupId, groupMemberId: memberId },
  });

  let got: MappedStreamEvent | undefined;
  for await (const event of stream as AsyncIterable<MappedStreamEvent>) {
    got = event;
    break; // one is enough; destroys the readable + ends the generator
  }
  reader.abort();

  expect(got).toBeDefined();
  expect(got!.messageId).toBe('m1');
  expect(got!.messageType).toBe('test');
  expect(got!.messageDestination).toBe(topic.producerKey());
  expect(got!.payload).toEqual({ hi: 'there' });

  // XACK is callable end-to-end (returns a number; 0 under NOACK reads — Gap C).
  const acked = await writer.markProcessedByGroup(topic, groupId, got!.streamMessageId!);
  expect(typeof acked).toBe('number');
}, 15000);
