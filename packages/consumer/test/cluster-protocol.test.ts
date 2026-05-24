/**
 * cluster-protocol clone-safety. `cluster-protocol.ts` is type-only; its contract is
 * that everything crossing the coordinator↔worker boundary is *plain data*, because
 * Bun `Worker.postMessage` uses structured clone (no functions, no class instances).
 *
 * Rather than assert the types abstractly, we exercise the real payload the coordinator
 * actually posts — `ConsumerGroupCluster.createMemberOptions` (the value behind
 * `{ type: 'start', params }`) — and assert it survives `structuredClone` intact. That
 * is the precise condition `postMessage` imposes. (No Redis: construction + option
 * assembly are inert; the data source connects lazily.)
 *
 * Run: bun test packages/consumer/test/cluster-protocol.test.ts
 */
import { test, expect, describe } from 'bun:test';
import path from 'path';
import { Topic } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { makeTopic, REDIS } from './harness';

const fileTarget = path.resolve(import.meta.dir, 'fixtures', 'cluster-echo-member.ts');

function makeCluster() {
  return new ConsumerGroupCluster(
    { topic: makeTopic('cp'), bidirectional: true, redisConfiguration: REDIS },
    { name: 'cp-group', count: 2, processingTimeout: 1000, idleTimeout: 500, blockTimeout: 50, prefetch: 3, retry: { maxAttempts: 4 } },
    fileTarget,
  );
}

describe('cluster-protocol clone-safety', () => {
  test('the start payload (createMemberOptions) is plain data and survives structuredClone intact', () => {
    const params = makeCluster().createMemberOptions('cp-group-0');

    // The contract first, before any matcher touches `params`: it round-trips through
    // structured clone with no loss — i.e. the coordinator can actually postMessage it
    // to a worker. (Asserted before field checks because `bun:test`'s asymmetric
    // matchers can attach internal, non-cloneable state to a matched object.)
    expect(() => structuredClone(params)).not.toThrow();
    expect(structuredClone(params)).toEqual(params);

    // The topic crosses as plain TopicOptions, NOT a Topic instance (a class instance
    // would be flattened by structured clone, losing its methods).
    expect(params.connectionSettings.topic).not.toBeInstanceOf(Topic);
    expect(typeof params.connectionSettings.topic.namespace).toBe('string');
    expect(typeof params.connectionSettings.topic.topic).toBe('string');

    // Config is plumbed through onto the clone-safe payload.
    expect(params.connectionSettings.retry).toEqual({ maxAttempts: 4 });
    expect(params.connectionSettings.prefetch).toBe(3);
    expect(params.processingTimeout).toBe(1000);
    expect(params.idleTimeout).toBe(500);
    expect(params.memberSettings).toEqual({ groupId: 'cp-group', groupMemberId: 'cp-group-0' });
  });

  test('structured clone rejects a function — why handlers/loggers are excluded from the payload', () => {
    // The reason the type is dependency-free and excludes eventMap/logger: a function
    // cannot cross the worker boundary. This pins the constraint the contract encodes.
    expect(() => structuredClone({ handler: () => {} })).toThrow();
  });
});
