import * as LRUCache from 'lru-cache';
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
  localStore: Record<string, any> = {};
  logger?: StreamersonLogger;

  constructor(public options: DataSourceOptions) {
    const url = `redis://${options.host ?? 'localhost'}:${options.port ?? 6379}`;
    this.client = createClient({ url });
    this.invalidationChannel = createClient({ url });
    this.cachedChannel = createClient({ url });
    this.logger = options.logger;
    this.cache = new LRUCache({ ttl: SECONDS_TO_MS(600) });
    this.beginCacheListener = this.beginCacheListener.bind(this);
  }

  has(options: KeyOptions, _stateConfig?: StateConfiguration): boolean {
    return this.cache.has(options.key);
  }

  async incrOrDecr(type: 'incr' | 'decr', options: KeyOptions, stateConfig?: StateConfiguration): Promise<number | null> {
    let value = 0;
    try {
      const { owner = false, replicated = false, rent = false } = stateConfig ?? {};
      const cacheKey = shardDecorator(options);
      let dispatchRemote = false;
      if (owner) {
        const val = parseInt((this.cache.get(cacheKey) as string | undefined) ?? '0');
        this.cache.set(cacheKey, (val + (type === 'incr' ? 1 : -1)).toString());
        value = val + (type === 'incr' ? 1 : -1);
        if (replicated) {
          dispatchRemote = true;
        }
      } else if (rent) {
        this.invalidateCache(null, cacheKey);
        dispatchRemote = true;
      }

      if (dispatchRemote) {
        // Channel where we don't receive LOOP invalidation:
        if (owner) { // We've already made the change here:
          this.cachedChannel[type](cacheKey).then(() => { }).catch((err: any) => {
            this.logger?.error(err, 'Failure to replicate cache while INCR:');
          });
          return value;
        } else {
          // For these, we will need to await the next GET:
          return await this.client[type](cacheKey);
        }
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
      const cacheable = stateConfig?.replicated || stateConfig?.rent;

      if (cacheable) {
        if (this.cache.has(cacheKey)) {
          const cachedEntry = this.cache.get(cacheKey);
          if (cachedEntry) {
            return cachedEntry as string;
          }
        }
        this.cache.set(cacheKey, 'caching in progress');
      }

      const result = await (cacheable ? this.cachedChannel : this.client).get(cacheKey);

      if (cacheable) {
        if (result) {
          this.cache.set(cacheKey, result);
        } else {
          this.cache.delete(cacheKey);
        }
      }

      return result;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call GET [key=${options.key},shard=${options.shard}]`);
    }
  }

  async getHash<T extends Record<string, string>>(options: KeyOptions, stateConfig?: StateConfiguration): Promise<T | null> {
    try {
      const cacheKey = shardDecorator(options);
      const cacheable = stateConfig?.replicated || stateConfig?.rent;

      if (cacheable) {
        if (this.cache.has(cacheKey)) {
          const cachedEntry = this.cache.get(cacheKey);
          if (cachedEntry) {
            return cachedEntry as T;
          }
        }
        this.cache.set(cacheKey, 'caching in progress');
      }

      const result = await (cacheable ? this.cachedChannel : this.client).hGetAll(cacheKey);

      if (cacheable) {
        if (result) {
          this.cache.set(cacheKey, result);
        } else {
          this.cache.delete(cacheKey);
        }
      }

      return result ? result as unknown as T : null;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call GET [key=${options.key},shard=${options.shard}]`);
    }
  }

  // TODO: finish me
  async del(_options: KeyOptions, _stateConfig: StateConfiguration): Promise<boolean> {
    return false;
  }

  async set(options: KeyOptions, value: string | number | null, stateConfig: StateConfiguration): Promise<boolean> {
    try {
      if (value === null) {
        return this.del(options, stateConfig);
      }
      const { owner, replicated, rent } = stateConfig;
      const cacheKey = shardDecorator(options);
      let dispatchRemote = false;
      if (owner) {
        this.cache.set(cacheKey, value.toString());
        if (replicated) {
          dispatchRemote = true;
        }
      } else if (rent) {
        this.invalidateCache(null, cacheKey);
        dispatchRemote = true;
      }

      if (dispatchRemote) {
        // Channel where we don't receive LOOP invalidation:
        if (owner) {
          this.cachedChannel.set(cacheKey, value.toString()).then(() => { }).catch((err: any) => {
            this.logger?.error(err, 'Failure to replicate cache during SET');
          });
          return true;
        } else {
          // For these, we will need to await the next GET:
          await this.client.set(cacheKey, value.toString());
        }
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
      const { owner, replicated, rent } = stateConfig;
      const cacheKey = shardDecorator(options);
      const hashCurrent = (this.cache.has(cacheKey) ? this.cache.get(cacheKey)! : {});
      const assignedRecord = Object.assign(hashCurrent, hashRecord);
      let dispatchRemote = false;
      if (owner) {
        this.cache.set(cacheKey, assignedRecord);
        if (replicated) {
          dispatchRemote = true;
        }
      } else if (rent) {
        this.invalidateCache(null, cacheKey);
        dispatchRemote = true;
      }

      if (dispatchRemote) {
        const hashFlattened = Object.entries(assignedRecord).flat() as string[];
        // Channel where we don't receive LOOP invalidation:
        if (owner || replicated) {
          this.cachedChannel.hSet(cacheKey, hashFlattened).then(() => { }).catch((err: any) => {
            this.logger?.error({ err, assignedRecord, hashCurrent, hashRecord }, 'Failure to replicate cache during HASH SET');
          });
        } else {
          // For these, we will need to await the next GET:
          await this.client.hSet(cacheKey, hashFlattened);
        }
      }

      return true;
    } catch (err) {
      console.error(err);
      throw new Error(`Failed attempt to call SET [key=${options.key}, shard=${options.shard}, value=${JSON.stringify(hashRecord)}]`);
    }
  }

  async beginCacheListener() {
    await Promise.all([this.cachedChannel.connect(), this.invalidationChannel.connect()]);
    await this.invalidationChannel.subscribe('__redis__:invalidate', this.invalidateCache.bind(this));
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

  invalidateCache(...args: any[]) {
    if (args[0]) {
      this.logger?.warn({ args }, `Received invalidation message for ${args[0]}`);
      const invalidationKey = args[1] as string;
      if (invalidationKey === '1') {
        return;
      }
      this.cache.delete(invalidationKey);
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
