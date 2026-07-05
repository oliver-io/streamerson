/**
 * Invalidation suite (TEST_PLAN.md §3 2.1/2.2, §4 3.4; BEHAVIOR_AUDIT.md 2.1, 2.2, 3.4).
 *
 * Shape:
 *  - CONTROL: harness-only clients prove that CLIENT TRACKING ON REDIRECT delivers a
 *    real __redis__:invalidate push naming the touched key on this Redis — isolating
 *    any product failure below from the environment.
 *  - 2.1A spec: the product's own connect choreography enables tracking, so a renter
 *    converges to an owner-replicated value.
 *  - 2.2 spec: with the tracking wiring performed by the harness, a genuine
 *    invalidation push evicts the renter's stale entry (handler reads the key from the
 *    message argument).
 *  - 3.4 activation contract: (a) end-to-end — "connect() resolving implies tracking is
 *    live"; (b) Redis-side wire contract — after product connect, the cached channel
 *    shows tracking on with redirect (CLIENT LIST), the same ground-truth oracle class
 *    as XPENDING in the consumer suite.
 *  - D12 reconnect: after the cached channel is CLIENT KILLed, the LRU is flushed and
 *    tracking is re-armed before the next cacheable read — proven end-to-end by a
 *    post-reconnect convergence cycle that requires a live invalidation push.
 *
 * (The PIN companions that documented the pre-fix wrongness of 2.1/2.2/3.4 were
 * retired when the activation fixes landed; these spec tests are the permanent
 * regression guards.)
 *
 * Requires a live Redis ≥6 (`bun run start:redis`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip,
  testRig,
  rawObserver,
  makeDatasource,
  awaitReplicated,
  until,
  sleep,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

// Flag configs at datasource altitude (a public consistency contract; observations go
// through ground truth or served values — TEST_PLAN §2 altitude rule).
const OWNER_REPLICATED: StateConfiguration = { owner: true, replicated: true } as StateConfiguration;
const RENT: StateConfiguration = { rent: true } as StateConfiguration;

/**
 * Window rationale: the CONTROL test proves a real invalidation push arrives well
 * inside 2000ms on this Redis (observed latency is single-digit ms on localhost);
 * 2000ms is the until() bound every convergence below runs under.
 */
const DELIVERY_BOUND_MS = 2000;

/** Tolerant key-extraction from a RESP2 invalidation pub/sub delivery: Redis pushes
 * the invalidated key(s) as the message payload; depending on node-redis decoding it
 * may surface as a string, Buffer, or array of either. */
function messagesName(messages: unknown[], key: string): boolean {
  const flat = messages.flatMap((m) => (Array.isArray(m) ? m : [m]));
  return flat.some((m) => String(m) === key);
}

const gated = describe.skipIf(!assertGateOrSkip());

gated('invalidation (audit 2.1 / 2.2 / 3.4)', () => {
  // -------------------------------------------------------------------------
  // CONTROL — expected GREEN
  // -------------------------------------------------------------------------
  it('CONTROL: real CLIENT TRACKING REDIRECT between harness-only clients delivers a __redis__:invalidate push naming the key', async () => {
    const ks = rig.keyspace('inv-control');
    const K = ks.key('k');

    // Three harness-only clients: subscriber (redirect target), tracked reader, and
    // the rig's observer as the out-of-band writer.
    const sub = rawObserver();
    const tracked = rawObserver();
    rig.onTeardown(async () => { await sub.quit(); });
    rig.onTeardown(async () => { await tracked.quit(); });
    await sub.connect();
    await tracked.connect();

    const subId = Number(await sub.sendCommand(['CLIENT', 'ID']));
    const received: unknown[] = [];
    // node-redis subscribe callback is (message, channel) — record the message only.
    await sub.client.subscribe('__redis__:invalidate', (message: unknown) => { received.push(message); });

    expect(await tracked.sendCommand(['CLIENT', 'TRACKING', 'ON', 'REDIRECT', String(subId)])).toBe('OK');
    await tracked.get(K); // registers interest in K on the tracked connection
    await rig.observer.set(K, 'mutated'); // third client mutates → Redis must push

    const arrived = await until(() => messagesName(received, K), DELIVERY_BOUND_MS);
    expect(arrived).toBe(true);
    expect(messagesName(received, K)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2.1 Test A — shipped connect path
  // -------------------------------------------------------------------------
  it('2.1A SPEC: after an owner replicates a new value, a renter on the shipped connect path serves it on its next get (BEHAVIOR_AUDIT.md 2.1)', async () => {
    const ks = rig.keyspace('inv-21a');
    const K = ks.key('k');
    await rig.observer.set(K, 'v1');

    const ownerDs = await makeDatasource(rig, { name: 'inv-21a-owner' });
    const renter = await makeDatasource(rig, { name: 'inv-21a-renter' });

    // Renter reads (caches v1 in its LRU).
    expect(await renter.get({ key: K }, RENT)).toBe('v1');

    // Owner sets a new value; fire-and-forget replication confirmed via ground truth.
    await ownerDs.set({ key: K }, 'v2', OWNER_REPLICATED);
    await awaitReplicated(rig.observer, K, 'v2');

    // Spec: the renter's next get converges to v2 within a small bound (see window
    // rationale above — the mechanism, when wired, delivers in single-digit ms).
    const converged = await until(async () => (await renter.get({ key: K }, RENT)) === 'v2', DELIVERY_BOUND_MS);
    expect(converged).toBe(true);
    expect(await renter.get({ key: K }, RENT)).toBe('v2');
  });

  // -------------------------------------------------------------------------
  // 2.1 Test B / 2.2 — handler contract isolated
  // -------------------------------------------------------------------------
  it('2.2 SPEC: with the spec\'s tracking wiring performed (real CLIENT TRACKING REDIRECT), a genuine invalidation push evicts the renter\'s stale entry (BEHAVIOR_AUDIT.md 2.2: the handler reads the key from the message argument)', async () => {
    const ks = rig.keyspace('inv-22');
    const K = ks.key('k');
    await rig.observer.set(K, 'v1');

    // Spec wiring, NOT a mock (docs/guidance/TESTING.md §1): the harness performs the
    // product's missing choreography step — real CLIENT ID, real subscribe with the
    // PRODUCT's handler, real CLIENT TRACKING ON REDIRECT via the product's enableCache.
    const renter = await makeDatasource(rig, { tracking: true, name: 'inv-22-renter' });

    // Seed the LRU behaviorally through the product's public get (registers tracking
    // interest on cachedChannel, the tracked connection).
    expect(await renter.get({ key: K }, RENT)).toBe('v1');
    expect(renter.cache.has(K)).toBe(true); // secondary sanity probe only

    // GENUINE invalidation: a third client SETs the key; Redis pushes via the redirect.
    // (Wire-equivalent fallback if the push proved unreliable would be
    // `PUBLISH __redis__:invalidate K` — identical to what a RESP2 redirect subscriber
    // receives — but the real push is primary and the CONTROL proves it works.)
    await rig.observer.set(K, 'v2');

    // Spec (primary = served value; cache.has as secondary): the renter stops serving
    // the stale value once the push lands.
    const evicted = await until(async () => (await renter.get({ key: K }, RENT)) === 'v2', DELIVERY_BOUND_MS);
    expect(evicted).toBe(true);
    expect(renter.cache.has(K) && renter.cache.get(K) === 'v1').toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3.4 activation contract
  // -------------------------------------------------------------------------
  it('3.4a SPEC: connect() resolving implies tracking is live — a post-connect remote mutation reaches a renter\'s served reads (BEHAVIOR_AUDIT.md 3.4)', async () => {
    const ks = rig.keyspace('inv-34a');
    const K = ks.key('k');
    await rig.observer.set(K, 'v1');

    // The activation contract framing: the ONLY product surface exercised is the
    // shipped connect path; if it resolves, invalidation must already be armed.
    const renter = await makeDatasource(rig, { name: 'inv-34a-renter' });
    expect(await renter.get({ key: K }, RENT)).toBe('v1');

    await rig.observer.set(K, 'v2'); // out-of-band mutation after connect resolved

    const live = await until(async () => (await renter.get({ key: K }, RENT)) === 'v2', DELIVERY_BOUND_MS);
    expect(live).toBe(true);
  });

  it('3.4b SPEC: after product connect, the cached channel\'s server-side tracking state is ON with a redirect (BEHAVIOR_AUDIT.md 3.4)', async () => {
    // Why this is behavior, not implementation: CLIENT TRACKING state is the process's
    // WIRE CONTRACT with Redis — the server-side fact that determines whether Redis
    // will ever push invalidations to this client. Observing it via an out-of-band
    // CLIENT LIST is the same ground-truth oracle class as XPENDING/XINFO in the
    // consumer suite (TEST_PLAN §4): external Redis state, not framework internals.
    const ds = await makeDatasource(rig, { name: 'inv-34b' });
    // Ensure the SETNAME tags are visible server-side before listing.
    await sleep(0);

    const list = await rig.observer.clientList();
    const cached = list.find((c) => c['name'] === 'inv-34b:cached');
    expect(cached).toBeDefined();
    // Redis ≥6 CLIENT LIST: `flags` contains 't' when tracking is on; `redir` is the
    // redirect target's client id, or -1 when no redirect is configured.
    const flags = cached!['flags'] ?? '';
    const redir = cached!['redir'] ?? '-1';
    expect(flags.includes('t')).toBe(true);
    expect(redir).not.toBe('-1');
    void ds;
  });

  // -------------------------------------------------------------------------
  // D12 — reconnect policy: flush the LRU on cachedChannel reconnect; tracking
  // re-armed before the next cacheable read (TEST_PLAN §6 D12)
  // -------------------------------------------------------------------------
  it('D12 SPEC: after the cached channel is killed and reconnects, a renter converges to the current value AND a further mutation cycle proves tracking is live again', async () => {
    const ks = rig.keyspace('inv-d12');
    const K = ks.key('k');
    await rig.observer.set(K, 'v1');

    const renter = await makeDatasource(rig, { name: 'inv-d12' });
    expect(await renter.get({ key: K }, RENT)).toBe('v1'); // caches v1

    // Kill the tracked cached channel server-side — the tracking table dies with the
    // connection; node-redis auto-reconnects.
    const list = await rig.observer.clientList();
    const cached = list.find((c) => c['name'] === 'inv-d12:cached');
    expect(cached).toBeDefined();
    expect(await rig.observer.clientKillById(cached!['id']!)).toBe(true);

    // Mutation during/after the reconnect window: no invalidation push can arrive for
    // v1 (the interest registration died with the killed connection). Only the D12
    // flush-on-reconnect makes the next read miss the LRU and fetch v2.
    await rig.observer.set(K, 'v2');
    const flushed = await until(async () => (await renter.get({ key: K }, RENT)) === 'v2', DELIVERY_BOUND_MS);
    expect(flushed).toBe(true);

    // Second cycle: v2 is now cached on the RECONNECTED channel; converging to v3
    // requires a live invalidation push — proving tracking was re-armed.
    await rig.observer.set(K, 'v3');
    const rearmed = await until(async () => (await renter.get({ key: K }, RENT)) === 'v3', DELIVERY_BOUND_MS);
    expect(rearmed).toBe(true);
  });
});
