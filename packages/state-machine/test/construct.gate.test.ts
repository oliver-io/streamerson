/**
 * Construction gate (TEST_PLAN.md §2 "Gate", BEHAVIOR_AUDIT.md 1.0/2.9): can the
 * package be instantiated at all? Everything else in the suite skip-gates on G1 via
 * `assertGateOrSkip()` — a RED gate must produce ONE loud failure here plus explicit
 * skips elsewhere, never cascading crashes.
 *
 * G1 is the one Category-1 test permitted to land RED. Its failure output classifies
 * the cause so the (spec-neutral, one-line) fix conversation starts informed:
 *  - lru-cache v7 options validation: `new LRUCache({ ttl })` with none of
 *    max/maxSize/ttlAutopurge set throws TypeError (cacheable.ts constructor), or
 *  - namespace-import interop: `import * as LRUCache from 'lru-cache'` yielding a
 *    non-constructible namespace object under Bun's CJS interop.
 *
 * GATE STATUS (run 2026-07-03, bun 1.3.14, Redis live): G1 RED —
 *   TypeError: Module is not a constructor
 *     (evaluating 'new LRUCache({ ttl: SECONDS_TO_MS(600) })')
 * i.e. the NAMESPACE-IMPORT INTEROP failure: under Bun, `import * as LRUCache from
 * 'lru-cache'` yields a module namespace object, and `new` on it throws before
 * lru-cache's own options validation (which would reject `{ ttl }` next — audit 2.9's
 * other hypothesis remains latent behind this one). G2–G4 skip while the gate is RED.
 *
 * Requires Redis (`bun run start:redis`) for G4 only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
// StateObjectTypes lives in core/src/types.ts but is not re-exported from core's
// index (an upstream export gap, noted for the audit) — subpath import required.
import { StateObjectTypes } from '@streamerson/core/src/types';
import { StateCache } from '../src/state-cache';
import { StreamStateMachine } from '../src/stream-state-machine';
import type { StateConfiguration } from '../src/types';
import { REDIS, canConstruct, quietLogger, testRig, makeTopic } from './harness';

const stateConfigurations: Record<string, StateConfiguration> = {
  counters: { type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true },
  profile: { type: StateObjectTypes.StandaloneHash, owner: false, rent: true },
};

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

describe('construction gate', () => {
  it('G1: CacheableDataSource constructs (lru-cache options + import interop survive)', () => {
    const g = canConstruct();
    if (!g.ok) {
      const msg = g.error.message;
      const diagnosis =
        /max|maxSize|ttlAutopurge/i.test(msg)
          ? 'lru-cache v7 OPTIONS VALIDATION: `new LRUCache({ ttl })` requires one of max/maxSize/ttlAutopurge (cacheable.ts:30)'
          : /not a constructor|is not a function|callable|construct/i.test(msg)
            ? 'NAMESPACE-IMPORT INTEROP: `import * as LRUCache` (cacheable.ts:1) did not yield a constructible class under Bun'
            : 'UNCLASSIFIED construction failure (neither known hypothesis matches — read the raw error)';
      throw new Error(`GATE RED — ${diagnosis}. Raw error: ${g.error.name}: ${msg}`);
    }
    expect(g.ok).toBe(true);
  });

  // G2–G4 depend on the same constructor; while G1 is RED they skip explicitly.
  const gated = it.skipIf(!canConstruct().ok);

  gated('G2: StateCache constructs over a full state-configuration map', () => {
    const cache = new StateCache({
      logger: quietLogger,
      stateConfigurations,
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
    });
    expect(cache.autoCache).toBeDefined();
    expect(cache.stateConfigurations).toBe(stateConfigurations as any);
  });

  gated('G3: StreamStateMachine constructs with one transformer per state key plus getClient', () => {
    const machine = new StreamStateMachine<any>({
      topic: makeTopic('gate-g3'),
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
      bidirectional: true,
      logger: quietLogger,
      stateConfigurations,
    });
    for (const stateKey of Object.keys(stateConfigurations)) {
      const t = (machine.stateTransformers as any)[stateKey];
      expect(t).toBeDefined();
      for (const op of ['get', 'set', 'incr', 'decr', 'getHash', 'setHash', 'transfer', 'broadcast'] as const) {
        expect(typeof t[op]).toBe('function');
      }
    }
    expect(typeof (machine.stateTransformers as any).getClient).toBe('function');
  });

  gated('G4: StateCache connect() then disconnect() round-trips against live Redis leaving no open clients', async () => {
    const ks = rig.keyspace('gate-g4');
    const cache = new StateCache<{ profile: any }>({
      logger: quietLogger,
      stateConfigurations: { profile: { type: StateObjectTypes.StandaloneString, owner: false, rent: true } },
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
    });
    await cache.connect();
    // Behavioral proof the connection is live: a renter write is AWAITED-durable, so
    // ground truth must hold the value the moment the promise resolves (audit 1.4).
    await cache.set('profile', { key: ks.key('probe') }, 'alive');
    expect(await rig.observer.get(ks.key('probe'))).toBe('alive');
    await cache.disconnect();
    expect(cache.autoCache.client.isOpen).toBe(false);
    expect(cache.autoCache.cachedChannel.isOpen).toBe(false);
    expect(cache.autoCache.invalidationChannel.isOpen).toBe(false);
  });
});
