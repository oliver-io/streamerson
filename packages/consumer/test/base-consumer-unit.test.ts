/**
 * Base `StreamConsumer` units that the group member doesn't supersede (no Redis —
 * `process`/`cacheComposite` are pure given a decoded event; routing is driven by
 * emitting on the bound channel). The group member overrides the consume loop with
 * `dispatch`/`terminal`, so these base behaviours are only reachable directly.
 *
 * Contract pinned here:
 *  - base `process`: no registered handler → returns an `Error` object (the single-
 *    consumer signal) rather than throwing or silently dropping; a registered handler
 *    → the event re-stamped `messageType: 'resp'` carrying the handler's payload;
 *  - `cacheComposite`: the documented `{ key, shard }` shape;
 *  - `bindStreamEvents` routes a channel `error` to a registered listener — preferring
 *    the per-stream event, else the generic one — and otherwise logs it (never an
 *    unhandled throw).
 *
 * Run: bun test packages/consumer/test/base-consumer-unit.test.ts
 */
import { test, expect, describe } from 'bun:test';
import type { MappedStreamEvent } from '@streamerson/core';
import { StreamConsumer } from '../src/base/stream-consumer';
import { makeTopic, REDIS } from './harness';

const makeConsumer = (tag: string, eventMap: Record<string, (e: any) => any> = {}, shard?: string) =>
  new StreamConsumer({ topic: makeTopic(tag), redisConfiguration: REDIS, bidirectional: false, shard, eventMap });

const event = (messageType: string, payload: object): MappedStreamEvent =>
  ({ streamId: 's', streamMessageId: '1-0', messageId: 'x', messageType: messageType as any, payload } as MappedStreamEvent);

describe('StreamConsumer.process', () => {
  test('no registered handler → returns an Error naming the type + consumer key (not a throw)', async () => {
    const consumer = makeConsumer('bp-nohandler', { echo: async () => ({}) });
    const result = await consumer.process(event('mystery', { a: 1 }));
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('No handler registered for message type: mystery');
    expect((result as Error).message).toContain(consumer.topic.consumerKey());
  });

  test('registered handler → event re-stamped resp carrying the handler payload', async () => {
    const consumer = makeConsumer('bp-handler', { echo: async (e: any) => ({ echoed: e.payload?.hi }) });
    const result = await consumer.process(event('echo', { hi: 'world' }));
    expect(result).not.toBeInstanceOf(Error);
    const msg = result as MappedStreamEvent;
    expect(msg.messageType).toBe('resp');
    expect(msg.payload).toEqual({ echoed: 'world' });
    expect(msg.messageId).toBe('x');           // correlation preserved
  });
});

describe('StreamConsumer.cacheComposite', () => {
  test('returns { key, shard }', () => {
    expect(makeConsumer('cc-noshard').cacheComposite('k')).toEqual({ key: 'k', shard: undefined });
    expect(makeConsumer('cc-shard', {}, 'shard-7').cacheComposite('k')).toEqual({ key: 'k', shard: 'shard-7' });
  });
});

describe('StreamConsumer channel-event routing (bindStreamEvents)', () => {
  test('wires an error handler on the incoming channel', () => {
    const consumer = makeConsumer('br-wired');
    expect(consumer.incomingStream.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });

  test('routes a channel error to the generic listener when no per-stream listener exists', () => {
    const consumer = makeConsumer('br-fallback');
    let routed: unknown;
    consumer.on('error', (e) => { routed = e; });
    const err = new Error('boom-fallback');
    consumer.incomingStream.emit('error', err);
    expect(routed).toBe(err);
  });

  test('prefers the per-stream `<stream>Error` event over the generic `error`', () => {
    const consumer = makeConsumer('br-primary');
    const primaryEvent = `${consumer.topic.consumerKey()}Error`;
    let viaPrimary: unknown;
    let viaGeneric = false;
    consumer.on(primaryEvent, (e) => { viaPrimary = e; });
    consumer.on('error', () => { viaGeneric = true; });
    const err = new Error('boom-primary');
    consumer.incomingStream.emit('error', err);
    expect(viaPrimary).toBe(err);
    expect(viaGeneric).toBe(false); // the per-stream event won; generic not also fired
  });

  test('logs the error (no unhandled throw) when nothing is listening', () => {
    const consumer = makeConsumer('br-log');
    let logged: unknown;
    consumer.logger.error = ((e: unknown) => { logged = e; }) as any;
    const err = new Error('boom-log');
    expect(() => consumer.incomingStream.emit('error', err)).not.toThrow();
    expect(logged).toBe(err);
  });
});
