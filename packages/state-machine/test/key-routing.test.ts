/**
 * Per-key configuration routing (TEST_PLAN.md §2 item 1.2; BEHAVIOR_AUDIT.md 1.2 —
 * GREEN pins).
 *
 * Three clauses: (a) the three consistency flags produce three observably distinct
 * write behaviors on ONE subject (datasource altitude — the plan permits it because
 * `CacheableDataSource` is a public consistency contract and every oracle here is the
 * out-of-band observer); (b) `dataKey(target, ctx)` derivation determines the physical
 * Redis key, asserted full-loop through a real machine and computed the public way via
 * `expectedKeyFor` (never a hardcoded string); (c) a configured shard suffixes the
 * physical key, so sharded and unsharded machines making identical writes land on
 * different keys.
 *
 * Requires Redis (`bun run start:redis`).
 *
 * (Historical FINDINGs retired: the `streamEvents` define-semantics wipe is fixed via
 * `declare` on the override, and the A8 double-shard-decoration in the consumer layer
 * — which left sharded consumers deaf and pinned (c) RED — is fixed at
 * consumer/src/base/stream-consumer.ts + member.ts. All three clauses assert the spec
 * and are expected GREEN.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip, testRig, makeMachine, makeDatasource, write, awaitResponse,
  awaitReplicated, expectedKeyFor,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const gated = describe.skipIf(!assertGateOrSkip());

gated('per-key configuration routing (1.2)', () => {
  it('a: on one datasource, owner+replicated writes poll-land in Redis, rent writes are durable at resolve, and owner-only writes write through too (2.5/D13)', async () => {
    const ks = rig.keyspace('routing-flags');
    const ds = await makeDatasource(rig, { name: 'routing-flags' });

    // owner+replicated: returns locally, replication is fire-and-forget — the ONLY
    // sanctioned observation is poll-to-convergence (harness awaitReplicated).
    const ownRepKey = ks.key('own-rep');
    expect(await ds.set({ key: ownRepKey }, 'replicated-eventually', {
      type: StateObjectTypes.StandaloneString, owner: true, replicated: true,
    })).toBe(true);
    await awaitReplicated(rig.observer, ownRepKey, 'replicated-eventually');

    // rent: the remote write is AWAITED — ground truth must hold the value the
    // moment the promise resolves, with NO polling (the behavioral teeth vs owner).
    const rentKey = ks.key('rent');
    expect(await ds.set({ key: rentKey }, 'durable-at-resolve', {
      type: StateObjectTypes.StandaloneString, owner: false, rent: true,
    })).toBe(true);
    expect(await rig.observer.get(rentKey)).toBe('durable-at-resolve');

    // owner-only: FLIPPED with the 2.5/D13 fix — owner state is write-through for
    // durability whether or not `replicated`; the flag differs only in
    // replica-serving intent. Same fire-and-forget observation as owner+replicated.
    const ownOnlyKey = ks.key('own-only');
    expect(await ds.set({ key: ownOnlyKey }, 'durable-too', {
      type: StateObjectTypes.StandaloneString, owner: true, replicated: false,
    })).toBe(true);
    await awaitReplicated(rig.observer, ownOnlyKey, 'durable-too');
  }, 15000);

  it('b: dataKey(target, ctx) derives the physical Redis key from handler context, matching expectedKeyFor', async () => {
    const ks = rig.keyspace('routing-datakey');
    const target = ks.key('profile');
    const stateConfigurations: Record<string, StateConfiguration> = {
      profiles: {
        type: StateObjectTypes.StandaloneString,
        owner: true,
        replicated: true,
        dataKey: (propertyTarget, context) => `${propertyTarget}:user:${context?.user?.id ?? 'anonymous'}`,
      },
    };
    const { machine, topic } = await makeMachine(rig, {
      tag: 'routing-datakey',
      stateConfigurations,
      handlers: {
        save: async (state, payload) => {
          await state.profiles.set(target, payload.value, { user: { id: payload.userId } });
          return { saved: true };
        },
      },
    });

    await write(rig.admin, topic, 'save', 'routing-datakey-1', { userId: 'u-42', value: 'ctx-derived' });
    const resp = await awaitResponse(topic, 'routing-datakey-1', 8000);
    expect(resp?.payload).toEqual({ saved: true });

    const context = { user: { id: 'u-42' } };
    const physicalKey = expectedKeyFor(machine, 'profiles', target, context);
    // The derivation actually happened (the physical key is not the bare target)...
    expect(physicalKey).not.toBe(target);
    // ...and Redis ground truth holds the value under exactly that derived key.
    await awaitReplicated(rig.observer, physicalKey, 'ctx-derived');
  }, 15000);

  it('c: identical writes from a sharded and an unsharded machine land on different physical keys', async () => {
    const ks = rig.keyspace('routing-shard');
    const target = ks.key('counter');
    const stateConfigurations: Record<string, StateConfiguration> = {
      counters: { type: StateObjectTypes.StandaloneString, owner: true, replicated: true },
    };
    const handlers = {
      save: async (state: any, payload: any) => {
        await state.counters.set(target, payload.value);
        return { saved: true };
      },
    };
    const sharded = await makeMachine(rig, { tag: 'routing-sharded', stateConfigurations, handlers, shard: 'alpha' });
    const unsharded = await makeMachine(rig, { tag: 'routing-unsharded', stateConfigurations, handlers });

    // Identical stimulus (same target, distinct values so the keys are tellable apart).
    await write(rig.admin, sharded.topic, 'save', 'routing-shard-a', { value: 'from-sharded' }, 'alpha');
    await write(rig.admin, unsharded.topic, 'save', 'routing-shard-b', { value: 'from-unsharded' });
    expect((await awaitResponse(sharded.topic, 'routing-shard-a', 8000, 'alpha'))?.payload).toEqual({ saved: true });
    expect((await awaitResponse(unsharded.topic, 'routing-shard-b', 8000))?.payload).toEqual({ saved: true });

    const shardedKey = expectedKeyFor(sharded.machine, 'counters', target);
    const unshardedKey = expectedKeyFor(unsharded.machine, 'counters', target);
    expect(shardedKey).not.toBe(unshardedKey);
    // Each write landed on its own physical key — no cross-shard bleed.
    await awaitReplicated(rig.observer, shardedKey, 'from-sharded');
    await awaitReplicated(rig.observer, unshardedKey, 'from-unsharded');
  }, 15000);
});
