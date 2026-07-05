/**
 * Regression tests for the topic+shard key-derivation inconsistency
 * (TESTING_ANALYSIS core gap 2; confirmed bug #3 — FIXED, tests are GREEN guards).
 *
 * One (topic, shard) pair must resolve to ONE consumer stream key everywhere:
 * the canonical form is `topic.consumerKey(shard)` (shard folded into the topic
 * segment, exactly once). getReadStream/getWriteStream's topic form now derives
 * that canonical key once and never re-applies `shardDecorator`; the raw-stream
 * form keeps the documented "undecorated key + shard" semantics.
 * Requires Redis (`bun run start:redis`).
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

const SHARD = 'shard-7';
const uniq = () => `sharded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const sources: StreamingDataSource[] = [];
const keys: string[] = [];

async function connected(): Promise<StreamingDataSource> {
  const ds = new StreamingDataSource(REDIS);
  await ds.connect();
  sources.push(ds);
  return ds;
}

/** Await the first event from a Readable within `ms`, else undefined. */
function firstEvent(stream: NodeJS.ReadableStream, ms: number): Promise<MappedStreamEvent | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    stream.once('data', (event: MappedStreamEvent) => {
      clearTimeout(timer);
      resolve(event);
    });
    stream.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/**
 * These tests assert KEY RENDEZVOUS (writer key === reader key), not arming
 * latency: the topic-form reader arms its `'$'` cursor at its first XREAD, so a
 * single write on a fixed sleep can race the arm-up under suite load (the A9
 * class). Repeat the write until the reader delivers — any delivery proves the
 * keys agree, which is the contract under test.
 */
async function writeUntilDelivered(
  pending: Promise<MappedStreamEvent | undefined>,
  writeOnce: () => Promise<unknown>,
  intervalMs = 250,
): Promise<MappedStreamEvent | undefined> {
  let done = false;
  const got = pending.then((e) => { done = true; return e; });
  while (!done) {
    await writeOnce();
    await Promise.race([got, new Promise((r) => setTimeout(r, intervalMs))]);
  }
  return got;
}

afterAll(async () => {
  const cleaner = new StreamingDataSource(REDIS);
  await cleaner.connect();
  for (const ds of sources) {
    try { ds.abort(); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 150));
  for (const ds of sources) {
    try { await ds.disconnect(); } catch { /* ignore */ }
  }
  // Delete canonical keys AND any stray mis-derived keys from the failing paths.
  for (const key of keys) {
    try {
      const strays = (await cleaner.client.send('KEYS', [`*${key.split('::')[0]}*`])) as string[];
      for (const stray of strays ?? []) await cleaner.client.send('DEL', [stray]);
    } catch { /* ignore */ }
  }
  await cleaner.disconnect();
});

test('getWriteStream({topic, shard}) writes to the canonical consumerKey(shard)', async () => {
  const topic = new Topic({ namespace: 'itest', topic: uniq() });
  const canonical = topic.consumerKey(SHARD);
  keys.push(canonical);
  const writer = await connected();

  const sink = writer.getWriteStream({ topic, shard: SHARD });
  await new Promise<void>((resolve, reject) => {
    sink.write({
      messageId: 'w1',
      messageType: 'test' as MessageType,
      payload: { hello: 'shard' },
      messageSourceId: 's1',
    } as MappedStreamEvent, (err) => (err ? reject(err) : resolve()));
  });

  const len = await writer.client.send('XLEN', [canonical]);
  expect(Number(len)).toBe(1);
}, 15000);

test('getReadStream({topic, shard}) delivers an entry written to the canonical consumerKey(shard)', async () => {
  const topic = new Topic({ namespace: 'itest', topic: uniq() });
  const canonical = topic.consumerKey(SHARD);
  keys.push(canonical);
  const reader = await connected();
  const writer = await connected();

  const stream = reader.getReadStream({ topic, shard: SHARD });
  const got = await writeUntilDelivered(firstEvent(stream, 8000), () => writer.writeToStream({
    outgoingStream: canonical,
    incomingStream: topic.producerKey(SHARD),
    messageType: 'test' as MessageType,
    messageId: 'r1',
    message: JSON.stringify({ hello: 'reader' }),
    sourceId: 's1',
  }));
  reader.abort();
  expect(got).toBeDefined();
  expect(got!.messageId).toBe('r1');
  expect(got!.payload).toEqual({ hello: 'reader' });
}, 15000);

test('sharded round-trip: getWriteStream({topic, shard}) rendezvouses with getReadStream({topic, shard})', async () => {
  const topic = new Topic({ namespace: 'itest', topic: uniq() });
  keys.push(topic.consumerKey(SHARD));
  const reader = await connected();
  const writer = await connected();

  const stream = reader.getReadStream({ topic, shard: SHARD });
  const sink = writer.getWriteStream({ topic, shard: SHARD });
  const got = await writeUntilDelivered(firstEvent(stream, 8000), () => new Promise<void>((resolve, reject) => {
    sink.write({
      messageId: 'rt1',
      messageType: 'test' as MessageType,
      payload: { round: 'trip' },
      messageSourceId: 's1',
    } as MappedStreamEvent, (err) => (err ? reject(err) : resolve()));
  }));
  reader.abort();
  expect(got).toBeDefined();
  expect(got!.messageId).toBe('rt1');
  expect(got!.payload).toEqual({ round: 'trip' });
}, 15000);
