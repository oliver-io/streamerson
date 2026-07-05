/**
 * Shared integration-test harness for the state-machine suite (TEST_PLAN.md §1).
 *
 * Philosophy bindings (docs/specs/TESTING.md, docs/guidance/TESTING.md):
 * - §5 "absorb setup into a reused harness": every complicated dance (three-client
 *   connect choreography, tracking enablement, restart simulation, prefix sweeps)
 *   lives here once, reviewed once.
 * - Real dependencies only: real node-redis clients (the same library the product
 *   uses), a live Redis, real `StreamStateMachine`s. No mocks anywhere.
 * - Ground truth is external: `rawObserver()` is an out-of-band client the product
 *   never sees; assertions about replication/durability go through it, never through
 *   the product's own cache.
 * - Converge-don't-sleep (guidance §4): positive waits use `until`/`awaitReplicated`;
 *   fixed windows exist only inside `never()` (negative assertions).
 *
 * Everything the suite needs is exported from here; test bodies should read as spec
 * sentences, not plumbing.
 */
import { expect } from 'bun:test';
import { createClient } from 'redis';
import Pino from 'pino';
import { StreamingDataSource, Topic, shardDecorator } from '@streamerson/core';
import type { MappedStreamEvent, MessageType, DataSourceOptions } from '@streamerson/core';
import { CacheableDataSource } from '../src/datasources/cacheable';
import { StateCache } from '../src/state-cache';
import { StreamStateMachine } from '../src/stream-state-machine';
import type { ApplicationState, StateConfiguration } from '../src/types';

type NodeRedisClient = ReturnType<typeof createClient>;

/** Silent logger: the suite asserts behavior, not log output, and pino's default
 * stdout stream drowns test reporting. */
export const quietLogger = Pino({ level: 'silent' }) as any;

export const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const REDIS_URL = `redis://${REDIS.host}:${REDIS.port}`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` until it returns true or `ms` elapses; resolves to the final result.
 * The ONLY sanctioned way to wait on a positive condition (guidance §4). */
export async function until(fn: () => boolean | Promise<boolean>, ms: number, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return await fn();
}

/**
 * Negative-window helper (guidance §4: "bounded window, then assert absence").
 * Polls `fn` for `ms`; the moment it turns true, fails loudly naming the forbidden
 * event. Callers state the window's rationale at the call site.
 */
export async function never(fn: () => boolean | Promise<boolean>, ms = 300, what = 'forbidden condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) throw new Error(`NEVER violated: ${what} occurred within the ${ms}ms window`);
    await sleep(25);
  }
  if (await fn()) throw new Error(`NEVER violated: ${what} occurred within the ${ms}ms window`);
}

/** A unique `itest` topic so repeated/parallel runs never collide on stream keys. */
export function makeTopic(tag: string): Topic {
  return new Topic({ namespace: 'itest', topic: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
}

// ---------------------------------------------------------------------------
// Construction gate (TEST_PLAN §1.1; audit 1.0/2.9)
// ---------------------------------------------------------------------------

export type GateResult = { ok: true } | { ok: false; error: Error };
let gateResult: GateResult | undefined;

/**
 * Probe whether `CacheableDataSource` constructs at all (audit 1.0: suspected
 * lru-cache v7 options-validation throw and/or `import * as` interop failure).
 * Memoized; opens no sockets (node-redis clients connect lazily), so probing is
 * side-effect free.
 */
export function canConstruct(): GateResult {
  if (!gateResult) {
    try {
      new CacheableDataSource({ host: REDIS.host, port: REDIS.port } as DataSourceOptions);
      gateResult = { ok: true };
    } catch (e) {
      gateResult = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
  return gateResult;
}

/**
 * Suite skip-gate: a RED gate must yield ONE loud failure (in construct.gate.test.ts)
 * plus N explicit skips — never N cascading crashes. Usage at the top of every
 * dependent suite file:
 *
 *   const gated = describe.skipIf(!assertGateOrSkip());
 *   gated('consistency matrix', () => { ... });
 */
export function assertGateOrSkip(): boolean {
  const g = canConstruct();
  if (!g.ok) {
    console.warn(`[state-machine harness] construction gate is RED — suite skipped. Gate error: ${g.error.name}: ${g.error.message}`);
  }
  return g.ok;
}

// ---------------------------------------------------------------------------
// Ground-truth observer (TEST_PLAN §1.2)
// ---------------------------------------------------------------------------

/**
 * Out-of-band ground truth: a plain node-redis client (the same library the product
 * uses — we trust it, philosophy §1) that the product never touches. All assertions
 * about "what is really in Redis" go through this, mirroring the consumer suite's
 * XPENDING/XRANGE oracle doctrine.
 */
export type RawObserver = {
  client: NodeRedisClient;
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<void>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** XRANGE key - + → field maps, matching the consumer harness's decoding. */
  xrange(key: string): Promise<Array<Record<string, string>>>;
  clientList(): Promise<Array<Record<string, string>>>;
  clientKillById(id: string | number): Promise<boolean>;
  publish(channel: string, message: string): Promise<number>;
  sendCommand(args: string[]): Promise<unknown>;
  /** SCAN out every key under `prefix` and DEL them (teardown sweep). */
  sweepPrefix(prefix: string): Promise<number>;
  quit(): Promise<void>;
};

export function rawObserver(): RawObserver {
  const client = createClient({ url: REDIS_URL });
  client.on('error', () => { /* observed via command rejections */ });
  return {
    client,
    async connect() { if (!client.isOpen) await client.connect(); },
    get: (key) => client.get(key),
    hgetall: (key) => client.hGetAll(key) as Promise<Record<string, string>>,
    async set(key, value) { await client.set(key, value); },
    del: (...keys) => client.del(keys),
    async exists(key) { return (await client.exists(key)) > 0; },
    async xrange(key) {
      const reply = await client.sendCommand(['XRANGE', key, '-', '+']) as Array<[string, string[]]> | null;
      return (reply ?? []).map(([, kv]) => {
        const f: Record<string, string> = {};
        for (let i = 0; i + 1 < kv.length; i += 2) f[String(kv[i])] = String(kv[i + 1]);
        return f;
      });
    },
    async clientList() {
      const raw = String(await client.sendCommand(['CLIENT', 'LIST']));
      return raw.split('\n').filter(Boolean).map((line) => {
        const f: Record<string, string> = {};
        for (const pair of line.trim().split(' ')) {
          const eq = pair.indexOf('=');
          if (eq > 0) f[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        return f;
      });
    },
    async clientKillById(id) {
      try { await client.sendCommand(['CLIENT', 'KILL', 'ID', String(id)]); return true; } catch { return false; }
    },
    publish: (channel, message) => client.publish(channel, message),
    sendCommand: (args) => client.sendCommand(args),
    async sweepPrefix(prefix) {
      let n = 0;
      for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        await client.del(key as string);
        n++;
      }
      return n;
    },
    async quit() { try { if (client.isOpen) await client.quit(); } catch { /* */ } },
  };
}

// ---------------------------------------------------------------------------
// Redis capability probes (TEST_PLAN §1.11)
// ---------------------------------------------------------------------------

/** DEBUG SLEEP capability probe: only the widened-window 2.10 variants need it; suites
 * `skipIf(!await debugSleepAvailable(...))` rather than failing on a locked-down Redis. */
export async function debugSleepAvailable(observer: RawObserver): Promise<boolean> {
  try { await observer.sendCommand(['DEBUG', 'SLEEP', '0']); return true; } catch { return false; }
}

/** CLIENT SETNAME tagging where a raw client is injectable — lets `clientCount` filter
 * to the connections a specific test opened (counting tests run serial). */
export async function tagClient(client: NodeRedisClient, name: string): Promise<void> {
  await client.sendCommand(['CLIENT', 'SETNAME', name]);
}

/** Count live server-side connections matching `filter` (substring on name, or a
 * predicate over the parsed CLIENT LIST record). Ground truth for leak tests (2.13). */
export async function clientCount(observer: RawObserver, filter: string | ((info: Record<string, string>) => boolean)): Promise<number> {
  const list = await observer.clientList();
  const pred = typeof filter === 'string' ? (i: Record<string, string>) => (i['name'] ?? '').includes(filter) : filter;
  return list.filter(pred).length;
}

// ---------------------------------------------------------------------------
// Replication oracles (TEST_PLAN §1.6)
// ---------------------------------------------------------------------------

/**
 * The ONLY sanctioned way to observe a fire-and-forget owner write: poll ground truth
 * to convergence, then hard-expect the final value so a timeout produces a value diff,
 * not a bare boolean failure.
 */
export async function awaitReplicated(observer: RawObserver, key: string, expected: string, ms = 2000): Promise<void> {
  await until(async () => (await observer.get(key)) === expected, ms);
  expect(await observer.get(key)).toBe(expected);
}

/** Hash variant of `awaitReplicated`: converge on deep equality of HGETALL. */
export async function awaitReplicatedHash(observer: RawObserver, key: string, expected: Record<string, string>, ms = 2000): Promise<void> {
  const eq = async () => {
    const got = await observer.hgetall(key);
    return JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(expected).sort());
  };
  await until(eq, ms);
  expect(await observer.hgetall(key)).toEqual(expected);
}

// ---------------------------------------------------------------------------
// The rig (TEST_PLAN §1.3; ported from consumer/test/harness.ts testRig)
// ---------------------------------------------------------------------------

/** Per-test key namespace: every physical key a test creates starts with a unique
 * prefix so the teardown sweep can catch LATE fire-and-forget writes that land after
 * the tracked-key DEL (the whole reason the sweep exists). */
export type Keyspace = { prefix: string; key(name: string): string };

export function makeKeyspace(tag: string): Keyspace {
  const prefix = `itest-sm:${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}:`;
  return { prefix, key: (name: string) => `${prefix}${name}` };
}

export type Rig = ReturnType<typeof testRig>;

/**
 * Per-file rig: one admin StreamingDataSource (stream-altitude ops), one raw node-redis
 * observer (ground truth), LIFO teardown. Teardown order matters:
 *   closers LIFO → settle (in-flight fire-and-forget writes land) → DEL topic keys →
 *   prefix SCAN sweep (catches the late writes) → admin/observer quit.
 */
export function testRig() {
  const admin = new StreamingDataSource(REDIS);
  const observer = rawObserver();
  const topics: Topic[] = [];
  const keyspaces: Keyspace[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  return {
    admin,
    observer,
    /** Track a closeable (machine / datasource / cache) for disconnect at teardown. */
    track<T extends { disconnect(): Promise<unknown> | void }>(c: T): T {
      closers.push(async () => { await c.disconnect(); });
      return c;
    },
    /** Register an arbitrary teardown closer (runs LIFO alongside tracked disconnects). */
    onTeardown(fn: () => Promise<void> | void): void { closers.push(fn); },
    /** A unique tracked topic whose stream keys are deleted at teardown. */
    topic(tag: string): Topic { const t = makeTopic(tag); topics.push(t); return t; },
    /** A unique tracked key namespace, swept (SCAN prefix*) at teardown. */
    keyspace(tag: string): Keyspace { const ks = makeKeyspace(tag); keyspaces.push(ks); return ks; },
    async connect(): Promise<void> {
      await Promise.all([admin.connect(), observer.connect()]);
    },
    async teardown(): Promise<void> {
      for (const fn of [...closers].reverse()) { try { await fn(); } catch { /* */ } }
      await sleep(150); // let in-flight blocking reads observe closing / late writes land
      for (const t of topics) {
        try { await admin.client.send('DEL', [t.consumerKey(), t.producerKey(), t.deadLetterKey()]); } catch { /* */ }
      }
      for (const ks of keyspaces) { try { await observer.sweepPrefix(ks.prefix); } catch { /* */ } }
      try { await admin.disconnect(); } catch { /* */ }
      await observer.quit();
    },
  };
}

// ---------------------------------------------------------------------------
// Stream-altitude primitives (ported from consumer/test/harness.ts)
// ---------------------------------------------------------------------------

/** Write a request onto the topic's consumer (request) stream — the public stimulus
 * for full-loop ticker-tape tests (guidance §1: the stimulus is the public surface). */
export async function write(admin: StreamingDataSource, topic: Topic, messageType: string, messageId: string, payload: object, shard?: string): Promise<void> {
  await admin.writeToStream({
    outgoingStream: topic.consumerKey(shard),
    incomingStream: topic.producerKey(shard),
    messageType: messageType as MessageType,
    messageId,
    message: JSON.stringify(payload),
    sourceId: 'test',
  });
}

/** XRANGE any stream key → field maps (audit raw responses / wire assertions). */
export async function readEntries(admin: StreamingDataSource, key: string): Promise<Array<Record<string, string>>> {
  const reply = await admin.client.send('XRANGE', [key, '-', '+']) as Array<[string, string[]]>;
  return (reply ?? []).map(([, kv]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i + 1 < kv.length; i += 2) f[kv[i]] = kv[i + 1];
    return f;
  });
}

/** Wait for one correlated response (by `messageId`) off the producer key. */
export async function awaitResponse(topic: Topic, messageId: string, ms: number, shard?: string): Promise<MappedStreamEvent | undefined> {
  const reader = new StreamingDataSource(REDIS);
  await reader.connect();
  const stream = reader.getReadStream({ stream: topic.producerKey(shard), last: '0' });
  const found = (async () => {
    for await (const ev of stream as AsyncIterable<MappedStreamEvent>) {
      if (ev.messageId === messageId) return ev;
    }
    return undefined;
  })();
  const got = await Promise.race([found, sleep(ms).then(() => undefined)]);
  try { reader.abort(); } catch { /* */ }
  try { await reader.disconnect(); } catch { /* */ }
  return got;
}

// ---------------------------------------------------------------------------
// Subject constructors (TEST_PLAN §1.4/§1.5/§1.12)
// ---------------------------------------------------------------------------

export type MachineHandlers = Record<string, (state: any, payload: any, meta: { sourceId: string }) => Promise<any>>;

export type MakeMachineOptions = {
  tag: string;
  stateConfigurations: Record<string, StateConfiguration>;
  shard?: string;
  handlers?: MachineHandlers;
  /** Reuse an existing topic (machine pairs / restart-as-same-identity). */
  topic?: Topic;
  /** Default true; false leaves the machine constructed-but-cold. */
  connect?: boolean;
};

/**
 * A fully-wired `StreamStateMachine` on a fresh (or shared) topic; handlers go through
 * the public `registerStreamEvent`, connection through the public `connectAndListen`,
 * teardown through `disconnect` (tracked on the rig).
 */
export async function makeMachine(rig: Rig, opts: MakeMachineOptions): Promise<{ machine: StreamStateMachine<any>; topic: Topic }> {
  const topic = opts.topic ?? rig.topic(opts.tag);
  const machine = new StreamStateMachine<any>({
    topic,
    redisConfiguration: { host: REDIS.host, port: REDIS.port },
    bidirectional: true,
    shard: opts.shard,
    logger: quietLogger,
    stateConfigurations: opts.stateConfigurations,
  });
  for (const [event, handler] of Object.entries(opts.handlers ?? {})) {
    await machine.registerStreamEvent(event, handler as any);
  }
  // Idempotent-safe closer instead of rig.track(machine): the product's
  // disconnect() hangs forever when called on a never-connected machine OR a
  // second time after a successful disconnect (node-redis queues unsubscribe/quit
  // on closed clients without settling — audit-addendum lifecycle defect). Only
  // speak to open cache sockets, then drop the stream channels directly.
  rig.onTeardown(async () => {
    // Release D14 ownership claims (normally DEL'd by disconnect(), which this
    // closer deliberately avoids — see the hang note below).
    try { if (machine.ownershipClaims.length) await rig.observer.del(...machine.ownershipClaims); } catch { /* */ }
    await safeCloseDatasource(machine.stateCache.autoCache);
    try { (machine as any).incomingChannel?.abort?.(); } catch { /* */ }
    try { await (machine as any).incomingChannel?.disconnect?.(); } catch { /* */ }
    try { await (machine as any).outgoingChannel?.disconnect?.(); } catch { /* */ }
  });
  if (opts.connect !== false) await machine.connectAndListen();
  return { machine, topic };
}

/**
 * Two machines sharing one topic on distinct shards — the topology for transfer (2.4,
 * 3.1) and ownership-conflict (3.6/D14) tests. NOTE: the transfer channel's two
 * `StreamingDataSource`s are closed over inside `streamAwaiter` and are never
 * `connect()`ed by current code (audit 2.4), so there is nothing of theirs to quit;
 * the rig's teardown covers everything reachable. When 2.4's fix lands and they
 * connect, the 2.13 client-count regression guard is what catches the leak.
 */
export async function makeMachinePair(rig: Rig, opts: Omit<MakeMachineOptions, 'shard' | 'topic'> & { shards?: [string, string] }): Promise<{
  topic: Topic; a: StreamStateMachine<any>; b: StreamStateMachine<any>;
}> {
  const [shardA, shardB] = opts.shards ?? ['shard-a', 'shard-b'];
  const topic = rig.topic(opts.tag);
  const a = (await makeMachine(rig, { ...opts, topic, shard: shardA })).machine;
  const b = (await makeMachine(rig, { ...opts, topic, shard: shardB })).machine;
  return { topic, a, b };
}

/**
 * Compute the physical Redis key for a transformer operation the PUBLIC way — the
 * machine's own `cacheComposite` (key + configured shard) composed with core's
 * `shardDecorator` and the state config's optional `dataKey` derivation. Key
 * assertions must go through this, never a hardcoded string, so a change to key
 * composition breaks ONE helper, not the whole suite.
 */
export function expectedKeyFor(machine: StreamStateMachine<any>, stateKey: string, propertyTarget: string, context?: object): string {
  const conf: StateConfiguration = (machine.options as any).stateConfigurations[stateKey];
  const derived = conf.dataKey ? conf.dataKey(propertyTarget, (context ?? {}) as any) : propertyTarget;
  return shardDecorator(machine.cacheComposite(derived));
}

export type MakeDatasourceOptions = {
  /** Enable client tracking the way the spec intends (see enableTrackingLikeTheSpec). */
  tracking?: boolean;
  /** CLIENT SETNAME tag applied to the main + cached channels (for clientCount). */
  name?: string;
};

/**
 * A bare connected `CacheableDataSource` for matrix-altitude tests (still behavior,
 * not implementation: it is a public consistency contract, observed via ground truth).
 * Default path uses the product's own choreography (`beginCacheListener` + `connect`);
 * `tracking: true` substitutes `enableTrackingLikeTheSpec` (identical choreography
 * plus the CLIENT TRACKING wiring the product is missing).
 */
/**
 * Close a `CacheableDataSource` without hanging. node-redis queues commands
 * (`unsubscribe`, `quit`) issued on a closed client forever — they neither resolve
 * nor reject — so the product's `endCacheListener`/`disconnect` deadlock teardown
 * for any instance that was crash-abandoned, cleanly restarted away, or never
 * connected (found by the recovery and wire suites; audit-addendum material).
 * Only speak to open sockets; force-close anything that refuses a polite quit.
 */
export async function safeCloseDatasource(ds: CacheableDataSource): Promise<void> {
  const { client, cachedChannel, invalidationChannel } = ds;
  try { if (invalidationChannel?.isOpen) await invalidationChannel.unsubscribe('__redis__:invalidate'); } catch { /* */ }
  for (const c of [invalidationChannel, cachedChannel, client]) {
    if (!c?.isOpen) continue;
    try { await c.quit(); } catch { try { await c.disconnect(); } catch { /* */ } }
  }
}

export async function makeDatasource(rig: Rig, opts: MakeDatasourceOptions = {}): Promise<CacheableDataSource> {
  const ds = new CacheableDataSource({ host: REDIS.host, port: REDIS.port, logger: quietLogger } as DataSourceOptions);
  if (opts.tracking) {
    await enableTrackingLikeTheSpec(ds);
    await ds.connect();
  } else {
    await ds.beginCacheListener();
    await ds.connect();
  }
  if (opts.name) {
    try { await tagClient(ds.client, `${opts.name}:client`); } catch { /* */ }
    try { await tagClient(ds.cachedChannel, `${opts.name}:cached`); } catch { /* */ }
  }
  rig.onTeardown(() => safeCloseDatasource(ds));
  return ds;
}

/** A connected `StateCache` (the typed facade) for facade-altitude tests. */
export async function makeStateCache<AState>(rig: Rig, stateConfigurations: ApplicationState<AState>): Promise<StateCache<AState>> {
  const cache = new StateCache<AState>({
    logger: quietLogger,
    stateConfigurations,
    redisConfiguration: { host: REDIS.host, port: REDIS.port },
  });
  await cache.connect();
  rig.track(cache);
  return cache;
}

// ---------------------------------------------------------------------------
// Tracking enablement (TEST_PLAN §1.8) — NOT a mock
// ---------------------------------------------------------------------------

/**
 * Perform the client-tracking wiring the product intends but never executes (audit
 * 2.1/3.4): fetch the invalidation connection's client id BEFORE it enters subscriber
 * mode (CLIENT ID is not permitted on a RESP2 connection once subscribed), subscribe
 * it to `__redis__:invalidate` with the product's own handler, then issue a real
 * `CLIENT TRACKING ON REDIRECT <id>` on `cachedChannel` via the product's
 * `enableCache`. This replicates `beginCacheListener`'s choreography with the one
 * missing step added — the spec's wiring performed by the test, not a simulation.
 *
 * Must be called INSTEAD of `beginCacheListener` (before any channel connects);
 * `makeDatasource(rig, { tracking: true })` sequences this correctly.
 */
export async function enableTrackingLikeTheSpec(ds: CacheableDataSource): Promise<number> {
  if (!ds.invalidationChannel.isOpen) await ds.invalidationChannel.connect();
  const id = Number(await ds.invalidationChannel.sendCommand(['CLIENT', 'ID']));
  await ds.invalidationChannel.subscribe('__redis__:invalidate', ds.invalidateCache.bind(ds));
  if (!ds.cachedChannel.isOpen) await ds.cachedChannel.connect();
  await ds.enableCache(id);
  return id;
}

// ---------------------------------------------------------------------------
// Restart simulation (TEST_PLAN §1.9)
// ---------------------------------------------------------------------------

function nodeRedisChannelsOf(subject: CacheableDataSource | StateCache<any> | StreamStateMachine<any>): NodeRedisClient[] {
  const ds: CacheableDataSource =
    subject instanceof CacheableDataSource ? subject
      : subject instanceof StateCache ? subject.autoCache
        : (subject as StreamStateMachine<any>).stateCache.autoCache;
  return [ds.client, ds.cachedChannel, ds.invalidationChannel];
}

/**
 * Crash-abandon: drop a subject's connections the way a dying process would — socket
 * destruction with no QUIT, no unsubscribe, no cache flush (`client.disconnect()` in
 * node-redis forcibly closes without a goodbye). The subject's LRU state is then
 * unreachable, exactly like a real crash. Any connection that refuses to close is
 * registered for an afterAll `CLIENT KILL` by id (belt-and-braces, per plan §1.9).
 */
export async function crashAbandon(rig: Rig, subject: CacheableDataSource | StateCache<any> | StreamStateMachine<any>): Promise<void> {
  for (const c of nodeRedisChannelsOf(subject)) {
    let id: string | undefined;
    try { if (c.isOpen && !c.isPubSubActive) id = String(await c.sendCommand(['CLIENT', 'ID'])); } catch { /* */ }
    try { await c.disconnect(); } catch {
      if (id) { const killId = id; rig.onTeardown(async () => { await rig.observer.clientKillById(killId); }); }
    }
  }
  if (subject instanceof StreamStateMachine) {
    // The machine's stream channels (Bun client) also die with the "process":
    try { (subject as any).incomingChannel?.abort?.(); } catch { /* */ }
    try { await (subject as any).incomingChannel?.disconnect?.(); } catch { /* */ }
    try { await (subject as any).outgoingChannel?.disconnect?.(); } catch { /* */ }
  }
}

/**
 * Owner-restart simulation: end instance A (clean disconnect, or crash-abandon) and
 * build its successor with identical identity via `factory`. The two variants pin
 * different clauses — clean restart pins "state survives an orderly deploy", crash
 * pins "state survives a death" (audit 2.5/2.6; recovery invariants I-R1..3).
 */
export async function restartAs<T>(
  rig: Rig,
  prev: CacheableDataSource | StateCache<any> | StreamStateMachine<any>,
  mode: 'clean' | 'crash',
  factory: () => T | Promise<T>,
): Promise<T> {
  if (mode === 'clean') {
    if (prev instanceof CacheableDataSource) {
      await safeCloseDatasource(prev);
    } else {
      await prev.disconnect();
    }
  } else {
    await crashAbandon(rig, prev);
  }
  return await factory();
}
