// lru-cache v7 is `export =` (CJS class); import-equals is the interop-free form
// that both tsc (no esModuleInterop) and Bun construct correctly (audit A4/2.9).
import LRUCache = require('lru-cache');
import { createClient } from 'redis';
import { DataSourceOptions, KeyOptions, SECONDS_TO_MS, shardDecorator, StreamersonLogger } from '@streamerson/core';
import { StateConfiguration } from '../types';

type NodeRedisClient = ReturnType<typeof createClient>;

/**
 * Client-side-caching datasource backed by **node-redis** (not Bun's client).
 *
 * Redis client tracking / invalidation pushes are not surfaced by Bun's
 * `RedisClient` (verified — see tools/spikes/bun-client-tracking.ts), so
 * state-machine deliberately keeps node-redis here. It still builds, tests, and
 * runs under the Bun toolchain; node-redis is just a node-compatible library.
 */
export class CacheableDataSource {
  client: NodeRedisClient;
  invalidationChannel: NodeRedisClient;
  cachedChannel: NodeRedisClient;
  cache: LRUCache<string, string | {}>;
  logger?: StreamersonLogger;
  /** Redirect target (invalidationChannel's CLIENT ID) once tracking is armed. */
  private trackingRedirectId?: number;
  /** Pending re-arm after a cachedChannel reconnect; cacheable reads gate on it. */
  private trackingArm?: Promise<void>;
  /** Single-flight cold-read coalescing (audit 2.10): concurrent cacheable reads of
   *  one key share one remote fetch. Entries are removed in `finally`, so a failed
   *  fetch strands nothing. No sentinel value ever enters the LRU. */
  private inflightGet = new Map<string, Promise<string | null>>();
  private inflightHash = new Map<string, Promise<Record<string, string> | null>>();
  /** D-Hydration marker: cache keys this owner has read through from Redis (or
   *  deliberately made authoritative by writing/deleting). Distinguishes
   *  absent-in-Redis from not-yet-hydrated, so a genuinely-absent key costs exactly
   *  one round-trip and `incr` stops defaulting a cold key to '0'. */
  private hydrated = new Set<string>();
  private inflightHydration = new Map<string, Promise<void>>();

  constructor(public options: DataSourceOptions) {
    const url = `redis://${options.host ?? 'localhost'}:${options.port ?? 6379}`;
    this.client = createClient({ url });
    this.invalidationChannel = createClient({ url });
    this.cachedChannel = createClient({ url });
    this.logger = options.logger;
    // node-redis requires an 'error' listener for a dropped connection to be
    // survivable (auto-reconnect) instead of an unhandled error event (D12).
    for (const c of [this.client, this.invalidationChannel, this.cachedChannel]) {
      c.on('error', (err: unknown) => this.logger?.error(err, 'Redis client error'));
    }
    // lru-cache v7 rejects ttl-only options; ttlAutopurge preserves the expiry
    // semantics without introducing a size bound (see BEHAVIOR_AUDIT 2.9). The 600s
    // is only the FALLBACK for rent/replicated read-through entries (D13): per-key
    // `StateConfiguration.ttl` overrides it, and owner entries are set with a
    // per-entry ttl of 0 — never stale in v7 — so owner state never self-evicts.
    this.cache = new LRUCache({ ttl: SECONDS_TO_MS(600), ttlAutopurge: true });
    this.beginCacheListener = this.beginCacheListener.bind(this);
  }

  has(options: KeyOptions, _stateConfig?: StateConfiguration): boolean {
    // Same derived key the read/write paths use (audit 2.12): raw options.key would
    // miss locally-held sharded state.
    return this.cache.has(shardDecorator(options));
  }

  /** D13 per-key TTL for OWNER entries. `StateConfiguration.ttl` is in SECONDS.
   *  No configured ttl → per-entry ttl 0, which lru-cache v7 treats as "never stale"
   *  (isStale: `ttls[i] === 0` → false; verified against lru-cache 7.18.3), so owner
   *  state never self-evicts. */
  private ownerEntryOptions(cfg?: StateConfiguration): { ttl: number } {
    return { ttl: cfg?.ttl ? SECONDS_TO_MS(cfg.ttl) : 0 };
  }

  /** D13 per-key TTL for RENT/replicated read-through entries (seconds); undefined
   *  falls back to the cache-wide 600s default. */
  private rentedEntryOptions(cfg?: StateConfiguration): { ttl: number } | undefined {
    return cfg?.ttl ? { ttl: SECONDS_TO_MS(cfg.ttl) } : undefined;
  }

  /** D-Hydration (lazy owner read-through): before an owner op touches a locally-cold
   *  key, consult Redis once and become locally authoritative. Reads go over the
   *  UNTRACKED `client` channel on purpose — owner entries must never enter the
   *  server-side tracking table, or the owner's own replication writes would loop an
   *  invalidation back and evict its authoritative copy. Single-flighted; hot-path
   *  cost is one Set lookup on warm keys. */
  private async hydrate(cacheKey: string, kind: 'scalar' | 'hash', stateConfig?: StateConfiguration): Promise<void> {
    if (this.hydrated.has(cacheKey) || this.cache.has(cacheKey)) {
      this.hydrated.add(cacheKey);
      return;
    }
    const pending = this.inflightHydration.get(cacheKey);
    if (pending) {
      return await pending;
    }
    const fetch = (async () => {
      try {
        if (kind === 'hash') {
          const remote = await this.client.hGetAll(cacheKey);
          if (remote && Object.keys(remote).length) {
            this.cache.set(cacheKey, { ...remote }, this.ownerEntryOptions(stateConfig));
          }
        } else {
          const remote = await this.client.get(cacheKey);
          if (remote !== null) {
            this.cache.set(cacheKey, remote, this.ownerEntryOptions(stateConfig));
          }
        }
        // Marked even when Redis holds nothing: absent-in-Redis hydrates to a defined
        // empty state exactly once — no repeated round-trips, no spurious errors.
        this.hydrated.add(cacheKey);
      } finally {
        this.inflightHydration.delete(cacheKey);
      }
    })();
    this.inflightHydration.set(cacheKey, fetch);
    return await fetch;
  }

  async incrOrDecr(type: 'incr' | 'decr', options: KeyOptions, stateConfig?: StateConfiguration): Promise<number | null> {
    let value = 0;
    try {
      const { owner = false, rent = false } = stateConfig ?? {};
      const cacheKey = shardDecorator(options);
      if (owner) {
        await this.hydrate(cacheKey, 'scalar', stateConfig);
        const val = parseInt((this.cache.get(cacheKey) as string | undefined) ?? '0');
        value = val + (type === 'incr' ? 1 : -1);
        this.cache.set(cacheKey, value.toString(), this.ownerEntryOptions(stateConfig));
        // Owner write-through (D13/2.5): fire-and-forget, whether or not `replicated`
        // (the flag differs only in replica-serving intent, not durability). Ships the
        // post-incr VALUE, not an INCR delta (D-2.7): after any divergence, one more
        // owner write reconverges remote == local.
        this.cachedChannel.set(cacheKey, value.toString()).catch((err: any) => {
          this.logger?.error(err, 'Failure to replicate cache while INCR:');
        });
        return value;
      }
      if (rent) {
        // Renter: evict our own stale LRU copy once the remote write is durable,
        // so the next read re-fetches (read-your-writes; audit 2.3).
        const result = await this.client[type](cacheKey);
        this.cache.delete(cacheKey);
        return result;
      }
      return value;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call ${type.toUpperCase()} [key=${options.key}, shard=${options.shard}, value=${value}]`);
    }
  }

  async incr(options: KeyOptions, stateConfig?: StateConfiguration): Promise<number | null> {
    return await this.incrOrDecr('incr', options, stateConfig);
  }

  async decr(options: KeyOptions, stateConfig?: StateConfiguration): Promise<number | null> {
    return await this.incrOrDecr('decr', options, stateConfig);
  }

  async get(options: KeyOptions, stateConfig?: StateConfiguration): Promise<string | null> {
    try {
      const cacheKey = shardDecorator(options);
      if (stateConfig?.owner) {
        // Owner reads serve the locally-authoritative copy, hydrating a cold key
        // first (D-Hydration) — retires the A2 "owner-only get blindness" wart.
        await this.hydrate(cacheKey, 'scalar', stateConfig);
        return (this.cache.get(cacheKey) as string | undefined) ?? null;
      }
      const cacheable = stateConfig?.replicated || stateConfig?.rent;

      if (!cacheable) {
        return await this.client.get(cacheKey);
      }

      await this.armed(); // D12: tracking re-armed before any cacheable read
      const cachedEntry = this.cache.get(cacheKey);
      if (cachedEntry) {
        return cachedEntry as string;
      }
      const inflight = this.inflightGet.get(cacheKey);
      if (inflight) {
        return await inflight;
      }
      const fetch = (async () => {
        try {
          const result = await this.cachedChannel.get(cacheKey);
          if (result) {
            this.cache.set(cacheKey, result, this.rentedEntryOptions(stateConfig));
          } else {
            this.cache.delete(cacheKey);
          }
          return result;
        } finally {
          this.inflightGet.delete(cacheKey);
        }
      })();
      this.inflightGet.set(cacheKey, fetch);
      return await fetch;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call GET [key=${options.key},shard=${options.shard}]`);
    }
  }

  async getHash<T extends Record<string, string>>(options: KeyOptions, stateConfig?: StateConfiguration): Promise<T | null> {
    try {
      const cacheKey = shardDecorator(options);
      if (stateConfig?.owner) {
        // Owner reads serve the locally-authoritative copy, hydrating a cold key
        // first (D-Hydration); clone on return (audit 2.11b).
        await this.hydrate(cacheKey, 'hash', stateConfig);
        const entry = this.cache.get(cacheKey);
        return entry ? { ...(entry as Record<string, string>) } as T : null;
      }
      const cacheable = stateConfig?.replicated || stateConfig?.rent;

      if (!cacheable) {
        const result = await this.client.hGetAll(cacheKey);
        return result ? result as unknown as T : null;
      }

      await this.armed(); // D12: tracking re-armed before any cacheable read
      const cachedEntry = this.cache.get(cacheKey);
      if (cachedEntry) {
        // Clone on return (audit 2.11b): the LRU entry never escapes by reference.
        return { ...(cachedEntry as Record<string, string>) } as T;
      }
      const inflight = this.inflightHash.get(cacheKey);
      if (inflight) {
        const shared = await inflight;
        return shared ? { ...shared } as T : null;
      }
      const fetch = (async () => {
        try {
          const result = await this.cachedChannel.hGetAll(cacheKey);
          if (result) {
            // Cache its own clone so neither the shared fetch result nor any
            // returned record aliases the LRU entry.
            this.cache.set(cacheKey, { ...result }, this.rentedEntryOptions(stateConfig));
          } else {
            this.cache.delete(cacheKey);
          }
          return result;
        } finally {
          this.inflightHash.delete(cacheKey);
        }
      })();
      this.inflightHash.set(cacheKey, fetch);
      const result = await fetch;
      return result ? { ...result } as unknown as T : null;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call GET [key=${options.key},shard=${options.shard}]`);
    }
  }

  /** D-Delete: `set(K, null)` routes here — the scalar delete, algebra-symmetric with
   *  the write algebra. Owner: local delete + fire-and-forget DEL, returns true
   *  unconditionally. Renter: awaited DEL + local eviction, returns the Redis reply. */
  async del(options: KeyOptions, stateConfig?: StateConfiguration): Promise<boolean> {
    const { owner = false, rent = false } = stateConfig ?? {};
    const cacheKey = shardDecorator(options);
    try {
      if (owner) {
        this.cache.delete(cacheKey);
        // Authoritative absence: the marker stops a later hydration from
        // resurrecting the value out of a not-yet-DEL'd remote copy.
        this.hydrated.add(cacheKey);
        this.cachedChannel.del(cacheKey).catch((err: any) => {
          this.logger?.error(err, 'Failure to replicate cache during DEL');
        });
        return true;
      }
      if (rent) {
        const reply = await this.client.del(cacheKey);
        this.cache.delete(cacheKey);
        return reply > 0;
      }
      this.cache.delete(cacheKey);
      return false;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call DEL [key=${options.key}, shard=${options.shard}]`);
    }
  }

  async set(options: KeyOptions, value: string | number | null, stateConfig: StateConfiguration): Promise<boolean> {
    try {
      if (value === null) {
        return await this.del(options, stateConfig);
      }
      const { owner, rent } = stateConfig;
      const cacheKey = shardDecorator(options);
      if (owner) {
        // Local-first, then owner write-through (D13/2.5): fire-and-forget whether or
        // not `replicated` — the flag differs only in replica-serving intent. A full
        // overwrite needs no hydration; the write itself makes us authoritative.
        this.cache.set(cacheKey, value.toString(), this.ownerEntryOptions(stateConfig));
        this.hydrated.add(cacheKey);
        this.cachedChannel.set(cacheKey, value.toString()).catch((err: any) => {
          this.logger?.error(err, 'Failure to replicate cache during SET');
        });
        return true;
      }
      if (rent) {
        // Renter: evict our own stale LRU copy once the remote write is durable
        // (read-your-writes; audit 2.3).
        await this.client.set(cacheKey, value.toString());
        this.cache.delete(cacheKey);
      }
      return true;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call SET [key=${options.key}, shard=${options.shard}, value=${value}]`);
    }
  }

  async setHash<T extends Record<string, string>>(options: KeyOptions, propertyTarget: string | T, value: T | null, stateConfig: StateConfiguration): Promise<boolean> {
    const hashRecord = typeof propertyTarget === 'string' ? { [propertyTarget as string]: value } : propertyTarget as T;
    try {
      const { owner, rent } = stateConfig;
      const cacheKey = shardDecorator(options);
      // Wire payload is the caller's DELTA only — hSet merges remotely, so shipping
      // the local merge base would resurrect remotely-deleted fields (audit 2.11d).
      // D-Delete: null/undefined fields are field deletions — they split into an HDEL
      // arg list; non-null non-string values are JSON-serialized (audit 2.11c/A5).
      const deletions: string[] = [];
      const wireRecord: Record<string, string> = {};
      for (const [field, fieldValue] of Object.entries(hashRecord)) {
        if (fieldValue === null || fieldValue === undefined) {
          deletions.push(field);
        } else {
          wireRecord[field] = typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue);
        }
      }

      if (owner) {
        // Hydrate first (D-Hydration): the merge base must include remote fields, or a
        // restarted owner's partial write would clobber its own recovered hash.
        await this.hydrate(cacheKey, 'hash', stateConfig);
        // Merge the caller's delta into a CLONE of the current entry (audit 2.11b),
        // dropping deleted fields (D-Delete: the local merge drops the field).
        const current = this.cache.get(cacheKey);
        const merged: Record<string, unknown> = { ...(typeof current === 'object' && current !== null ? current : {}) };
        for (const [field, fieldValue] of Object.entries(hashRecord)) {
          if (fieldValue === null || fieldValue === undefined) {
            delete merged[field];
          } else {
            merged[field] = fieldValue;
          }
        }
        this.cache.set(cacheKey, merged, this.ownerEntryOptions(stateConfig));
        // Owner semantics: local-first, fire-and-forget write-through (as scalar set).
        if (Object.keys(wireRecord).length) {
          this.cachedChannel.hSet(cacheKey, wireRecord).catch((err: any) => {
            this.logger?.error({ err, hashRecord }, 'Failure to replicate cache during HASH SET');
          });
        }
        if (deletions.length) {
          this.cachedChannel.hDel(cacheKey, deletions).catch((err: any) => {
            this.logger?.error({ err, deletions }, 'Failure to replicate cache during HASH DEL');
          });
        }
      } else if (rent) {
        // Renter: awaited durability, then evict our own stale LRU copy so the
        // next read re-fetches (read-your-writes; audit 2.3 / 2.11a).
        if (Object.keys(wireRecord).length) {
          await this.client.hSet(cacheKey, wireRecord);
        }
        if (deletions.length) {
          await this.client.hDel(cacheKey, deletions);
        }
        this.cache.delete(cacheKey);
      }

      return true;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call SET [key=${options.key}, shard=${options.shard}, value=${JSON.stringify(hashRecord)}]`);
    }
  }

  async beginCacheListener() {
    // Activation choreography (audit 2.1/3.4): CLIENT ID must be fetched BEFORE the
    // connection enters subscriber mode (not permitted on a subscribed RESP2 client),
    // then tracking is redirected there from cachedChannel — live before connect resolves.
    await this.invalidationChannel.connect();
    const id = Number(await this.invalidationChannel.sendCommand(['CLIENT', 'ID']));
    await this.invalidationChannel.subscribe('__redis__:invalidate', this.invalidateCache.bind(this));
    await this.cachedChannel.connect();
    await this.enableCache(id);
    this.trackingRedirectId = id;
    // D12: a cachedChannel reconnect loses server-side tracking state — flush the LRU
    // (its entries are no longer invalidation-protected) and re-arm tracking before
    // the next cacheable read (reads gate on `trackingArm`). Registered after the
    // initial connect, so 'ready' here only fires on reconnects.
    this.cachedChannel.on('ready', () => {
      if (this.trackingRedirectId === undefined) return;
      this.cache.clear();
      // Owner entries were flushed with everything else — drop the hydration markers
      // so the next owner op reads back through (write-through makes that converge to
      // the last replicated value; an unreplicated in-flight write is the accepted
      // fire-and-forget loss window).
      this.hydrated.clear();
      this.trackingArm = this.enableCache(this.trackingRedirectId).catch((err: any) => {
        this.logger?.error(err, 'Failed to re-enable client tracking after reconnect');
      });
    });
  }

  /** Await any pending post-reconnect tracking re-arm before a cacheable read. */
  private async armed(): Promise<void> {
    if (this.trackingArm) {
      await this.trackingArm;
      this.trackingArm = undefined;
    }
  }

  async connect() {
    await this.client.connect();
    return this;
  }

  async endCacheListener() {
    await this.invalidationChannel.unsubscribe('__redis__:invalidate');
    await Promise.all([this.cachedChannel.quit(), this.invalidationChannel.quit()]);
  }

  async disconnect() {
    await this.client.quit();
  }

  // node-redis subscribe callbacks are (message, channel). A RESP2 redirect delivers
  // the invalidated key as the message (string/Buffer, or an array for multi-key
  // pushes); a null message means the whole tracking table was flushed.
  invalidateCache(message: unknown, _channel?: unknown) {
    if (message === null || message === undefined) {
      this.cache.clear();
      this.hydrated.clear(); // evicted owner entries must re-hydrate, not default cold
      return;
    }
    for (const key of Array.isArray(message) ? message : [message]) {
      this.cache.delete(String(key));
      this.hydrated.delete(String(key));
    }
  }

  // Client-side caching via REDIRECT tracking — requires node-redis (Bun's
  // client does not surface invalidation pushes).
  async enableCache(id: number) {
    if (await this.cachedChannel.clientTracking(true, { REDIRECT: id }) !== 'OK') {
      this.logger?.error(Error('Cannot enable client tracking'));
    } else {
      this.logger?.info(`Enabled client tracking for ID ${id}`);
    }
  }
}
