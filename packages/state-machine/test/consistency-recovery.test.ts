/**
 * Consistency recovery suite (TEST_PLAN.md §3 items 2.5/2.6/2.7; §4 3.2 invariants
 * I-R1/I-R2/I-R3). Datasource altitude: `CacheableDataSource` is a public consistency
 * contract; all durability/replication assertions go through the out-of-band observer
 * (ground truth), never the product's own cache.
 *
 * FIXED (audit 2.5/2.6/2.7): the SPEC tests below are the regression guards; their
 * documentary PINs were retired with the fixes.
 *
 * Implemented contracts (TEST_PLAN §6, resolved 2026-07-03):
 *  - 2.5 / D13: owner state is write-through — fire-and-forget replication whether or
 *    not `replicated` (the flag differs only in replica-serving intent) — and owner
 *    LRU entries carry per-entry ttl 0 (never self-evict). Per-key
 *    `StateConfiguration.ttl` (seconds) governs rent/replicated read-through entries.
 *  - 2.6 / I-R1: lazy owner read-through (D-Hydration S2) — owner ops on a
 *    locally-cold key consult Redis first, then become locally authoritative; a
 *    hydration marker makes a genuinely-absent key cost exactly one round-trip.
 *  - 2.7 / D-2.7: incr replication ships the post-incr VALUE (SET), not an INCR
 *    delta, so one owner write reconverges remote == local after any divergence.
 *
 * Requires Redis (`bun run start:redis`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
// StateObjectTypes is not re-exported from core's index (upstream export gap, noted
// in construct.gate.test.ts) — subpath import required.
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import { CacheableDataSource } from '../src/datasources/cacheable';
import {
  assertGateOrSkip,
  awaitReplicated,
  makeDatasource,
  restartAs,
  testRig,
  until,
  type Rig,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const ownerOnly: StateConfiguration = {
  type: StateObjectTypes.StandaloneNumber, owner: true, replicated: false,
};
const ownerReplicated: StateConfiguration = {
  type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true,
};
const ownerReplicatedString: StateConfiguration = {
  type: StateObjectTypes.StandaloneString, owner: true, replicated: true,
};

/**
 * THE named "bring restarted owner to serving state" step (TEST_PLAN §4 3.2): the
 * single edit point shared by 2.5/2.6/2.7 and the I-R invariants. Today (pre-fix)
 * a restarted owner is serving as soon as it is constructed and connected; when the
 * D-Hydration strategy lands (lazy read-through needs no explicit warm-up, but if a
 * hydration marker or recover() call ever becomes part of "serving", it goes HERE),
 * this one function changes and every invariant test follows.
 */
async function bringRestartedOwnerToServingState(
  r: Rig,
  prev: CacheableDataSource,
  mode: 'clean' | 'crash',
): Promise<CacheableDataSource> {
  // Teardown aid (harness finding, verified by probe): node-redis `unsubscribe` on a
  // closed client neither resolves nor rejects, so the harness's makeDatasource
  // teardown closer (`endCacheListener`) hangs forever on any restarted-away
  // instance — crash-abandoned OR already-cleanly-closed — and times out the
  // afterAll hook. LIFO closer order runs this suite-local closer FIRST, reopening
  // the predecessor's pub/sub channels so the harness closer's unsubscribe/quit can
  // complete. Runs strictly at teardown, after every assertion; it revives sockets,
  // never state, so it cannot mask the recovery behavior under test.
  r.onTeardown(async () => {
    for (const c of [prev.cachedChannel, prev.invalidationChannel]) {
      try { if (!c.isOpen) await c.connect(); } catch { /* */ }
    }
  });
  return await restartAs(r, prev, mode, () => makeDatasource(r));
}

/** Suite-local scenario constructor: a replicated owner counter driven to `n` with
 * replication CONFIRMED converged (the only sanctioned observation of a
 * fire-and-forget write) — the shared precondition for 2.6/2.7/I-R1/I-R3. */
async function seedReplicatedCounter(ds: CacheableDataSource, key: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    expect(await ds.incr({ key }, ownerReplicated)).toBe(i + 1);
  }
  await awaitReplicated(rig.observer, key, String(n));
}

const gated = describe.skipIf(!assertGateOrSkip());

// ---------------------------------------------------------------------------
// 2.5 — owner-only durability (crash-loss variant)
// ---------------------------------------------------------------------------

gated('2.5 owner-only durability (crash-loss variant)', () => {
  /**
   * Regression guard (BEHAVIOR_AUDIT.md 2.5, fixed): owner-only state is
   * write-through (fire-and-forget) and a restarted owner lazily hydrates, so the
   * successor incr continues the counter instead of defaulting to '0'.
   */
  it('SPEC(2.5): an owner-only counter incremented to N survives an owner crash — the successor incr yields N+1', async () => {
    const ks = rig.keyspace('rec-25-spec');
    const key = ks.key('owned-counter');
    const a = await makeDatasource(rig, { name: 'rec-25-spec-a' });
    for (let i = 0; i < 3; i++) {
      expect(await a.incr({ key }, ownerOnly)).toBe(i + 1);
    }
    const b = await bringRestartedOwnerToServingState(rig, a, 'crash');
    // The spec ("owner state never self-evicts / is recoverable", D13): N+1.
    expect(await b.incr({ key }, ownerOnly)).toBe(4);
  });
  // PIN(2.5) retired with the fix (owner-only writes now reach Redis; write-through).
});

// ---------------------------------------------------------------------------
// 2.6 — restart divergence on owner+replicated state
// ---------------------------------------------------------------------------

gated('2.6 restart divergence (owner+replicated)', () => {
  /**
   * Regression guards (BEHAVIOR_AUDIT.md 2.6, fixed): lazy owner read-through
   * (D-Hydration) — a restarted owner's first write op hydrates from Redis and
   * continues from the true value. PIN(2.6/clean|crash) retired with the fix.
   */
  for (const mode of ['clean', 'crash'] as const) {
    it(`SPEC(2.6/${mode}): after a ${mode} restart, the successor's incr on a replicated counter at 5 returns 6 AND remote converges to 6`, async () => {
      const ks = rig.keyspace(`rec-26-spec-${mode}`);
      const key = ks.key('counter');
      const a = await makeDatasource(rig, { name: `rec-26-spec-${mode}-a` });
      await seedReplicatedCounter(a, key, 5);
      const b = await bringRestartedOwnerToServingState(rig, a, mode);
      // Per D-Hydration lazy read-through: consult Redis first, become authoritative.
      expect(await b.incr({ key }, ownerReplicated)).toBe(6);
      await awaitReplicated(rig.observer, key, '6');
    });
  }
});

// ---------------------------------------------------------------------------
// 2.7 — reconciliation minimal invariant (resolved D-2.7: a bug, not a tradeoff)
// ---------------------------------------------------------------------------

gated('2.7 reconciliation minimal invariant', () => {
  /**
   * Regression guard (BEHAVIOR_AUDIT.md 2.7, fixed per resolved D-2.7): incr
   * replication ships the post-incr VALUE, so ONE more owner write reconverges
   * remote == local. Timing-free primary variant: the divergence source is the 2.6
   * restart (no induced outage needed). PIN(2.7) retired with the fix.
   */
  it('SPEC(2.7): after a restart-induced divergence, one more owner write reconverges remote == local', async () => {
    const ks = rig.keyspace('rec-27-spec');
    const key = ks.key('counter');
    const a = await makeDatasource(rig, { name: 'rec-27-spec-a' });
    await seedReplicatedCounter(a, key, 5);
    const b = await bringRestartedOwnerToServingState(rig, a, 'crash');
    await b.incr({ key }, ownerReplicated); // the diverging write (2.6 territory)
    // The reconciling write — after it, local is authoritative and remote MUST agree:
    const local = await b.incr({ key }, ownerReplicated);
    const converged = await until(async () => (await rig.observer.get(key)) === String(local), 2000);
    expect({ converged, local, remote: await rig.observer.get(key) })
      .toEqual({ converged: true, local, remote: String(local) });
  });

  // OPTIONAL .slow outage variant (CLIENT KILL the cachedChannel mid-window)
  // deliberately NOT written: killing cachedChannel makes node-redis buffer/replay or
  // reject depending on reconnect-race timing, so "the delta was dropped" cannot be
  // established deterministically — a flaky RED test would be noise, and the
  // timing-free primary above already captures the resolved D-2.7 invariant. Revisit
  // when D12 (flush-on-reconnect) lands and the reconnect contract is observable.
});

// ---------------------------------------------------------------------------
// 3.2 — strategy-agnostic recovery invariants I-R1/I-R2/I-R3 (target: D-Hydration
// lazy read-through; all share bringRestartedOwnerToServingState as the edit point)
// ---------------------------------------------------------------------------

gated('3.2 recovery invariants (spec-capture, strategy-agnostic)', () => {
  /**
   * Regression guard (BEHAVIOR_AUDIT.md 2.6 promoted to spec form, TEST_PLAN §4
   * 3.2 I-R1; fixed by D-Hydration lazy read-through).
   */
  it('I-R1: a restarted owner\'s incr agrees with Redis ground truth once replication settles', async () => {
    const ks = rig.keyspace('rec-ir1');
    const key = ks.key('counter');
    const a = await makeDatasource(rig, { name: 'rec-ir1-a' });
    await seedReplicatedCounter(a, key, 5);
    const b = await bringRestartedOwnerToServingState(rig, a, 'crash');
    const local = await b.incr({ key }, ownerReplicated);
    await until(async () => (await rig.observer.get(key)) === String(local), 2000);
    expect(await rig.observer.get(key)).toBe(String(local));
  });

  /**
   * LIKELY GREEN anchor (TEST_PLAN §4 3.2): the owner+replicated `get` path is
   * cacheable (`replicated || rent`, cacheable.ts get), so a cold successor's first
   * read misses the LRU and reads through to Redis — recovery already works for
   * reads; only the write paths are blind.
   */
  it('I-R2: a restarted owner\'s first get returns the last value written before the crash', async () => {
    const ks = rig.keyspace('rec-ir2');
    const key = ks.key('scalar');
    const a = await makeDatasource(rig, { name: 'rec-ir2-a' });
    expect(await a.set({ key }, 'v-final', ownerReplicatedString)).toBe(true);
    await awaitReplicated(rig.observer, key, 'v-final');
    const b = await bringRestartedOwnerToServingState(rig, a, 'crash');
    expect(await b.get({ key }, ownerReplicatedString)).toBe('v-final');
  });

  /**
   * Regression guard (BEHAVIOR_AUDIT.md 2.6/2.7 composite, TEST_PLAN §4 3.2 I-R3;
   * fixed): post-restart convergence is PERMANENT — local and remote agree after
   * the first post-restart write and stay agreeing after the second.
   */
  it('I-R3: post-restart convergence is permanent — local and remote agree after each of two successive writes', async () => {
    const ks = rig.keyspace('rec-ir3');
    const key = ks.key('counter');
    const a = await makeDatasource(rig, { name: 'rec-ir3-a' });
    await seedReplicatedCounter(a, key, 5);
    const b = await bringRestartedOwnerToServingState(rig, a, 'crash');
    const first = await b.incr({ key }, ownerReplicated);
    await until(async () => (await rig.observer.get(key)) === String(first), 2000);
    expect(await rig.observer.get(key)).toBe(String(first));
    const second = await b.incr({ key }, ownerReplicated);
    await until(async () => (await rig.observer.get(key)) === String(second), 2000);
    expect(await rig.observer.get(key)).toBe(String(second));
  });
});

// ---------------------------------------------------------------------------
// D13 — per-key StateConfiguration.ttl (seconds)
// ---------------------------------------------------------------------------

gated('D13 per-key ttl', () => {
  it('a rent entry with ttl:1 re-fetches after expiry — a remote change becomes visible without invalidation', async () => {
    const rentTtl: StateConfiguration = {
      type: StateObjectTypes.StandaloneString, owner: false, rent: true, ttl: 1,
    };
    const ks = rig.keyspace('d13-rent-ttl');
    const key = ks.key('k');
    await rig.observer.set(key, 'v1');
    const ds = await makeDatasource(rig, { name: 'd13-rent-ttl' });
    expect(await ds.get({ key }, rentTtl)).toBe('v1'); // miss → fetch → cache with 1s ttl
    await rig.observer.set(key, 'v2'); // out-of-band change; no invalidation wiring here
    expect(await ds.get({ key }, rentTtl)).toBe('v1'); // still cached within the ttl
    // After the 1s ttl the entry is stale and the next read re-fetches:
    const refetched = await until(async () => (await ds.get({ key }, rentTtl)) === 'v2', 3000, 100);
    expect(refetched).toBe(true);
  });

  it('an owner entry (no ttl) never self-evicts: its remaining TTL is Infinity, vs finite for a rent entry', async () => {
    // lru-cache v7 semantics (verified against 7.18.3): a per-entry ttl of 0 means
    // "never stale" (isStale returns false when ttls[i] === 0), and getRemainingTTL
    // reports Infinity for such entries. This pins the never-expire mechanism the
    // crash-loss tests above rely on, without waiting out a wall-clock TTL.
    const ks = rig.keyspace('d13-owner-nottl');
    const ownedKey = ks.key('owned');
    const rentedKey = ks.key('rented');
    await rig.observer.set(rentedKey, 'r');
    const ds = await makeDatasource(rig, { name: 'd13-owner-nottl' });
    expect(await ds.set({ key: ownedKey }, 'o', ownerOnly as StateConfiguration)).toBe(true);
    expect(ds.cache.getRemainingTTL(ownedKey)).toBe(Infinity);
    expect(await ds.get({ key: rentedKey }, { type: StateObjectTypes.StandaloneString, owner: false, rent: true })).toBe('r');
    expect(Number.isFinite(ds.cache.getRemainingTTL(rentedKey))).toBe(true); // 600s default
  });
});
