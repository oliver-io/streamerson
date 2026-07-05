/**
 * Consistency matrix (TEST_PLAN.md §2 items 1.3/1.4/1.5, §3 items 2.3/2.10/2.11,
 * §0 addenda A1/A2) — datasource altitude per the plan's altitude rule:
 * `CacheableDataSource` is a public consistency contract; every assertion about
 * "what is really in Redis" goes through the rig's out-of-band observer.
 *
 * Section layout:
 *  - Cat-1 GREEN pins: 1.3 owner writes, 1.4 renter writes, 1.5 read-through, A1/A2.
 *  - 2.3 renter read-your-writes: fixed; the spec tests are the regression guards
 *    (their PINs were retired with the fix).
 *  - 2.10 single-flight cold reads and 2.11 setHash algebra: fixed; the spec tests
 *    are the regression guards (their PINs were retired with the fixes).
 *
 * Requires Redis (`bun run start:redis`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip,
  awaitReplicated,
  awaitReplicatedHash,
  makeDatasource,
  never,
  testRig,
  until,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

// The trimmed flag matrix (TEST_PLAN §2 "flag-matrix coverage"):
const OWNER_REP: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: true, replicated: true };
const OWNER_ONLY: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: true, replicated: false };
const RENTER: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: false, rent: true };
const RENTER_REP: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: false, rent: true, replicated: true };
const NOOP: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: false, rent: false };

const gated = describe.skipIf(!assertGateOrSkip());

// ---------------------------------------------------------------------------
// 1.3 — owner writes: local-first, fire-and-forget replication (GREEN)
// Scope guards per plan: no induced failures (2.7's), no second instance (2.6's),
// no pre-seeded Redis for owner incr (2.6's).
// ---------------------------------------------------------------------------
gated('1.3 owner writes — local-first, async replication', () => {
  it('an owner set returns true and is locally visible before any yield; replication lands asynchronously', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('owner-set').key('k');
    const pending = ds.set({ key }, 'v1', OWNER_REP);
    // Pre-any-yield: the LRU already holds the value the moment set() returns its
    // promise — local state is authoritative on the owner hot path (audit 1.3).
    expect(ds.has({ key }, OWNER_REP)).toBe(true);
    expect(ds.cache.get(key)).toBe('v1');
    expect(await pending).toBe(true);
    // Replication is fire-and-forget: observed ONLY via convergence on ground truth.
    await awaitReplicated(rig.observer, key, 'v1');
  });

  it('owner incr/decr algebra returns 1,2,3,2 locally and the remote converges to the final "2"', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('owner-incr').key('counter');
    expect(await ds.incr({ key }, OWNER_REP)).toBe(1);
    expect(await ds.incr({ key }, OWNER_REP)).toBe(2);
    expect(await ds.incr({ key }, OWNER_REP)).toBe(3);
    expect(await ds.decr({ key }, OWNER_REP)).toBe(2);
    // Post-op VALUES replicate fire-and-forget (D-2.7); assert the converged final value.
    await awaitReplicated(rig.observer, key, '2');
  });

  it('owner setHash (flat strings, single write) returns true and the full hash replicates', async () => {
    // GREEN envelope is deliberately flat-strings/single-write; everything richer
    // (merging, nesting, aliasing) is 2.11's RED territory.
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('owner-sethash').key('h');
    expect(await ds.setHash({ key }, { a: '1', b: '2' } as any, null, OWNER_REP)).toBe(true);
    await awaitReplicatedHash(rig.observer, key, { a: '1', b: '2' });
  });

  it('owner-only (replicated: false) writes are written through for durability (2.5/D13)', async () => {
    // FLIPPED with the 2.5 fix: owner state is write-through whether or not
    // `replicated` — the flag differs only in replica-serving intent, not durability.
    // Crash-recoverability of this copy is proven in consistency-recovery SPEC(2.5).
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('owner-only').key('k');
    expect(await ds.set({ key }, 'durable-too', OWNER_ONLY)).toBe(true);
    expect(await ds.incr({ key: `${key}-n` }, OWNER_ONLY)).toBe(1);
    await awaitReplicated(rig.observer, key, 'durable-too');
    await awaitReplicated(rig.observer, `${key}-n`, '1');
  });
});

// ---------------------------------------------------------------------------
// 1.4 — renter writes: awaited durability (GREEN)
// The behavioral teeth vs 1.3: ground truth is read IMMEDIATELY after the promise
// resolves, with NO polling. A renter never reads after its own write here (2.3's RED).
// ---------------------------------------------------------------------------
gated('1.4 renter writes — awaited remote durability', () => {
  it('a renter set is durable the moment its promise resolves (no polling)', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('renter-set').key('k');
    expect(await ds.set({ key }, 'durable', RENTER)).toBe(true);
    expect(await rig.observer.get(key)).toBe('durable'); // immediate — no until()
  });

  it('a renter incr on pre-seeded "10" returns 11, deferring to Redis as truth', async () => {
    const key = rig.keyspace('renter-incr').key('counter');
    await rig.observer.set(key, '10');
    const ds = await makeDatasource(rig);
    expect(await ds.incr({ key }, RENTER)).toBe(11);
    expect(await rig.observer.get(key)).toBe('11'); // immediate — no until()
  });

  it('a renter setHash (rent && !replicated) is durable the moment its promise resolves', async () => {
    // The rent && replicated cell takes the WRONG (fire-and-forget) branch — that
    // fork is 2.11 sub-test 1; this GREEN cell stays inside rent && !replicated.
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('renter-sethash').key('h');
    expect(await ds.setHash({ key }, { f: 'x' } as any, null, RENTER)).toBe(true);
    expect(await rig.observer.hgetall(key)).toEqual({ f: 'x' }); // immediate — no until()
  });
});

// ---------------------------------------------------------------------------
// 1.5 — read-through caching, sequential single-reader only (GREEN)
// Restricted to replicated||rent configs (A2 owns owner-only reads); strictly
// awaited sequential reads (2.10 owns concurrency).
// ---------------------------------------------------------------------------
gated('1.5 read-through caching — sequential happy path', () => {
  it('miss populates the cache and a hit serves locally, proven by out-of-band delete-then-reread', async () => {
    const key = rig.keyspace('readthrough').key('k');
    await rig.observer.set(key, 'v1');
    const ds = await makeDatasource(rig);
    expect(await ds.get({ key }, RENTER)).toBe('v1'); // miss → remote fetch → populate
    expect(ds.has({ key }, RENTER)).toBe(true); // secondary sanity only
    await rig.observer.del(key); // ground truth gone; only the LRU can answer now
    // ANNOTATION: this assertion FLIPS when invalidation (audit 2.1/2.2) lands —
    // a tracked delete would evict the entry and this read would return null.
    expect(await ds.get({ key }, RENTER)).toBe('v1'); // hit: served from the local LRU
  });

  it('getHash of a missing key returns {} rather than null', async () => {
    // WART PIN: node-redis hGetAll returns {} for an absent key; the truthy check in
    // getHash means callers get {} where the signature promises T | null, and the {}
    // is even cached. Pinned, not endorsed — flag when the missing-key contract is
    // specified.
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('gethash-missing').key('absent');
    const got = await ds.getHash({ key }, RENTER);
    expect(got).toEqual({} as any); // pinned: {} where null would be the honest answer
    expect(got).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A1/A2 — audit addenda pins (documentary GREEN; TEST_PLAN §0)
// ---------------------------------------------------------------------------
gated('A0 audit addenda — documentary pins', () => {
  it('A1 pin: {owner:false, rent:false} writes resolve successfully while writing nowhere', async () => {
    // Audit addendum A1 (silent no-op writes): dispatchRemote is never set, so the
    // write "succeeds" into the void. Documentary pin, Category-2-adjacent.
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('a1-noop').key('k');
    expect(await ds.set({ key }, 'void', NOOP)).toBe(true); // pinned: success with no destination
    await never(async () => await rig.observer.exists(key), 300, 'a no-flag write appeared in Redis');
    expect(await ds.get({ key }, NOOP)).toBeNull(); // nothing was written anywhere readable
  });

  it('A2: owner-only set then get serves the locally-held value (get blindness retired with D-Hydration)', async () => {
    // FLIPPED with the D-Hydration/2.5 fixes: owner reads now serve the
    // locally-authoritative LRU copy (hydrating a cold key from the write-through
    // copy first), so the old "get bypasses the LRU for owner-only" wart is gone.
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('a2-blind').key('k');
    expect(await ds.set({ key }, 'held-locally', OWNER_ONLY)).toBe(true);
    expect(ds.has({ key }, OWNER_ONLY)).toBe(true); // the LRU holds it...
    expect(await ds.get({ key }, OWNER_ONLY)).toBe('held-locally'); // ...and get serves it
  });
});

// ---------------------------------------------------------------------------
// Renter read-your-writes (BEHAVIOR_AUDIT.md 2.3): a renter's write evicts its own
// stale LRU entry once the remote write is durable, so its next read re-fetches.
// Ground truth confirms Redis holds the new value; the served value confirms the
// local eviction.
// ---------------------------------------------------------------------------
gated('2.3 renter read-your-writes', () => {
  it('spec: a renter that reads 1, writes 2, then reads again must read 2', async () => {
    const key = rig.keyspace('ryw-set').key('k');
    await rig.observer.set(key, '1');
    const ds = await makeDatasource(rig);
    expect(await ds.get({ key }, RENTER)).toBe('1'); // caches "1"
    expect(await ds.set({ key }, '2', RENTER)).toBe(true);
    expect(await rig.observer.get(key)).toBe('2'); // ground truth: the write really landed
    expect(await ds.get({ key }, RENTER)).toBe('2');
  });

  it('spec: a renter incr must be visible to its own next read', async () => {
    const key = rig.keyspace('ryw-incr').key('counter');
    await rig.observer.set(key, '5');
    const ds = await makeDatasource(rig);
    expect(await ds.get({ key }, RENTER)).toBe('5'); // caches "5"
    expect(await ds.incr({ key }, RENTER)).toBe(6);
    expect(await rig.observer.get(key)).toBe('6'); // ground truth agrees with the incr
    expect(await ds.get({ key }, RENTER)).toBe('6');
  });

  it('spec: a renter setHash must be visible to its own next read', async () => {
    // Previously GREEN only by defect cancellation (audit A6: the 2.11 in-place
    // aliasing overwrote the stale LRU entry). The renter path now deletes its LRU
    // entry after the awaited hSet (2.3), and the 2.11 aliasing defect itself is
    // fixed (clone-on-merge/clone-on-return) — green on eviction alone.
    const key = rig.keyspace('ryw-sethash').key('h');
    await rig.observer.sendCommand(['HSET', key, 'a', '1']);
    const ds = await makeDatasource(rig);
    expect(await ds.getHash({ key }, RENTER)).toEqual({ a: '1' } as any); // caches the hash
    expect(await ds.setHash({ key }, { a: '2' } as any, null, RENTER)).toBe(true);
    expect(await rig.observer.hgetall(key)).toEqual({ a: '2' }); // ground truth updated
    expect(await ds.getHash({ key }, RENTER)).toEqual({ a: '2' } as any); // spec: read your write
  });
});

// ---------------------------------------------------------------------------
// 2.10 concurrent cold reads (fixed): get/getHash coalesce same-key cold reads onto
// one in-flight remote fetch (single-flight map, removed in `finally`); the
// 'caching in progress' sentinel string no longer exists. These specs are the
// regression guards; the PINs of the sentinel leak were retired with the fix.
// ---------------------------------------------------------------------------
gated('2.10 concurrent-read sentinel', () => {
  it('spec: two same-tick gets on a cold cache both resolve to the real value', async () => {
    const key = rig.keyspace('sentinel-get').key('k');
    await rig.observer.set(key, 'real');
    const ds = await makeDatasource(rig);
    const [first, second] = await Promise.all([ds.get({ key }, RENTER), ds.get({ key }, RENTER)]);
    expect(first).toBe('real');
    expect(second).toBe('real');
  });

  it('spec: two same-tick getHash calls both resolve to objects (a Record, never a string)', async () => {
    const key = rig.keyspace('sentinel-hash').key('h');
    await rig.observer.sendCommand(['HSET', key, 'a', '1']);
    const ds = await makeDatasource(rig);
    const [first, second] = await Promise.all([ds.getHash({ key }, RENTER), ds.getHash({ key }, RENTER)]);
    expect(typeof first).toBe('object');
    expect(typeof second).toBe('object');
    expect(second).toEqual({ a: '1' } as any);
  });

  // Companion (fetch-failure cleanup): still document-skipped. The fix removes the
  // in-flight entry in a `finally`, so a failed fetch strands nothing — but proving
  // that end-to-end needs a remote GET that fails while the datasource stays
  // otherwise usable, and node-redis's reconnect/offline-queue semantics make an
  // induced mid-command failure inherently racy (the retried GET usually succeeds).
  // Without a deterministic failure seam this test would be timing-sensitive, which
  // the plan's risk register forbids as a primary.
  it.skip('spec (companion, timing-sensitive): a failed remote fetch must not strand an in-flight entry', () => {});
});

// ---------------------------------------------------------------------------
// 2.11 setHash algebra (fixed): setHash now follows the scalar owner/rent rules —
// owner is local-first with fire-and-forget replication, any non-owner renter path
// is awaited-durable with evict-after-durable (composing with 2.3); the local merge
// clones (no aliasing); the wire carries only the caller's delta with non-string
// values JSON-serialized. Four sub-specs plus a flag-parity spot check are the
// regression guards; the PINs of the old behavior were retired with the fix.
// ---------------------------------------------------------------------------
gated('2.11 setHash deviations', () => {
  // -- (1) renter-path fork: rent && replicated must take the renter's awaited path
  // (dispatch now branches on `owner`, matching scalar set). Made
  // deterministic by durable-or-reject under a dead cachedChannel: the client-side
  // disconnect (no QUIT, no reconnect — commands reject immediately) is used instead
  // of an observer CLIENT KILL because node-redis would otherwise reconnect and
  // replay the queued HSET, destroying determinism.
  it('spec: a rent && replicated setHash is durable-or-rejects — it must never claim success for a write that went nowhere', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('fork-spec').key('h');
    await ds.cachedChannel.disconnect(); // the fire-and-forget channel is dead; this.client is alive
    let rejected = false;
    let landed = false;
    try {
      await ds.setHash({ key }, { f: 'v' } as any, null, RENTER_REP);
      landed = (await rig.observer.hgetall(key))['f'] === 'v';
    } catch {
      rejected = true;
    }
    // Renter algebra: awaited-durable via this.client (alive), so it lands.
    expect(rejected || landed).toBe(true);
  });

  it('flag-parity spot check: the scalar set under rent && replicated IS awaited-durable (the fork is setHash-only)', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('fork-parity').key('k');
    expect(await ds.set({ key }, 'v', RENTER_REP)).toBe(true);
    expect(await rig.observer.get(key)).toBe('v'); // immediate — scalar algebra holds
  });

  // -- (2) aliasing, both directions.
  it('spec: mutating a record returned by getHash must not leak back into the cache', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('alias-out').key('h');
    await ds.setHash({ key }, { a: '1' } as any, null, OWNER_REP);
    const got = await ds.getHash({ key }, OWNER_REP);
    (got as any).a = 'hacked'; // caller mutates their copy — must be THEIR copy
    // getHash returns a clone; the LRU entry is untouched.
    expect(await ds.getHash({ key }, OWNER_REP)).toEqual({ a: '1' } as any);
  });

  it('spec: a caller-held record mutation must not leak into the cache and onto the wire via the merge base', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('alias-in').key('h');
    await ds.setHash({ key }, { a: '1' } as any, null, OWNER_REP);
    await awaitReplicatedHash(rig.observer, key, { a: '1' });
    const held = await ds.getHash({ key }, OWNER_REP); // a clone, not the LRU entry
    (held as any).smuggled = 'x'; // caller-side mutation, never passed to setHash
    await ds.setHash({ key }, { b: '2' } as any, null, OWNER_REP);
    // Converge on the write we DID make, then assert the smuggled field never shipped.
    await until(async () => (await rig.observer.hgetall(key))['b'] === '2', 2000);
    const remote = await rig.observer.hgetall(key);
    expect(remote['b']).toBe('2');
    expect(remote['smuggled']).toBeUndefined(); // no aliasing, and the wire is delta-only
  });

  // -- (3) nested values: non-string hash values are JSON-serialized on the wire
  // (audit A5's silent whole-write drop is gone; the fix serializes the delta).
  it('spec: nested hash values round-trip to Redis', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('nested-spec').key('h');
    expect(await ds.setHash({ key }, { nested: { x: 1 } } as any, null, OWNER_REP)).toBe(true);
    await until(async () => (await rig.observer.hgetall(key))['nested'] !== undefined, 2000);
    const wire = (await rig.observer.hgetall(key))['nested'];
    expect(wire).toBeDefined();
    expect(wire).not.toBe('[object Object]');
    expect(JSON.parse(wire!)).toEqual({ x: 1 });
  });

  // -- (4) deleted-field resurrection: the wire carries only the caller's delta
  // (hSet is already a merge remotely), so a stale local merge base cannot re-ship
  // remotely-deleted fields.
  it('spec: an externally deleted field must not be resurrected by a later unrelated setHash', async () => {
    const ds = await makeDatasource(rig);
    const key = rig.keyspace('resurrect-spec').key('h');
    await ds.setHash({ key }, { a: '1', b: '2' } as any, null, OWNER_REP);
    await awaitReplicatedHash(rig.observer, key, { a: '1', b: '2' });
    await rig.observer.sendCommand(['HDEL', key, 'b']); // out-of-band delete
    await ds.setHash({ key }, { c: '3' } as any, null, OWNER_REP); // touches only c
    await until(async () => (await rig.observer.hgetall(key))['c'] === '3', 2000);
    const remote = await rig.observer.hgetall(key);
    expect(remote['c']).toBe('3');
    expect(remote['b']).toBeUndefined();
  });
});
