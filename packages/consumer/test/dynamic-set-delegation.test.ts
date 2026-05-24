/**
 * Dynamic stream-set — the consumer's responsibility (no Redis: the set is synchronous
 * bookkeeping on the incoming channel). `addStream`/`hasStream`/`removeStream` are thin
 * delegators to `incomingChannel.addStreamId`/`hasStreamId`/`removeStreamId`, so this
 * pins that the consumer wires them through and that membership reflects mutations.
 *
 * The *behavioural* runtime contract (a stream added/removed at runtime is folded into /
 * dropped from a LIVE read with no interruption of the others) belongs to the channel
 * and is owned by the deterministic acceptance suite
 * `packages/core/test/streams/datasource/dynamic-stream-set.test.ts` (STREAM_READER_DEFECTS
 * F1 — now fixed, that suite passes). It is not duplicated here.
 *
 * Run: bun test packages/consumer/test/dynamic-set-delegation.test.ts
 */
import { test, expect } from 'bun:test';
import { StreamConsumer } from '../src/base/stream-consumer';
import { makeTopic, REDIS } from './harness';

test('addStream/hasStream/removeStream delegate to the channel stream-set and track membership', () => {
  const consumer = new StreamConsumer({ topic: makeTopic('dynset'), redisConfiguration: REDIS, bidirectional: false });
  const extra = 'itest::extra-stream::CONSUMER_INCOMING';

  expect(consumer.hasStream(extra)).toBe(false);   // not in the set yet
  consumer.addStream(extra);
  expect(consumer.hasStream(extra)).toBe(true);     // added → membership reflects it
  consumer.removeStream(extra);
  expect(consumer.hasStream(extra)).toBe(false);    // removed → membership reflects it

  // The consumer's own primary (request) stream is registered by construction.
  expect(consumer.hasStream(consumer.topic.consumerKey())).toBe(true);
});
