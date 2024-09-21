import * as LRUCache from 'lru-cache'
import {DataSourceOptions, KeyOptions, RedisDataSource, SECONDS_TO_MS, shardDecorator} from "@streamerson/core";
import {StateConfiguration} from "@streamerson/state-machine";

export class CacheableDataSource extends RedisDataSource {
    invalidationChannel: RedisDataSource;
    cachedChannel: RedisDataSource;
    cache: LRUCache<string, string | {}>;
    localStore: Record<string, any> = {};
    constructor(args: DataSourceOptions) {
        super(args);
        this.invalidationChannel = new RedisDataSource(args);
        this.cachedChannel = new RedisDataSource(args);
        this.cache = new LRUCache({
            ttl: SECONDS_TO_MS(600)
        });
        this.beginCacheListener = this.beginCacheListener.bind(this);
    }

    has(options: KeyOptions, stateConfig?: StateConfiguration): boolean {
        return this.cache.has(options.key);
    }

    async incrOrDecr(type: 'incr' | 'decr', options: KeyOptions, stateConfig?: StateConfiguration): Promise<number | null> {
        let value = 0;
        try {
            const { owner = false, replicated = false, rent = false } = stateConfig ?? {};
            const cacheKey = shardDecorator(options);
            let dispatchRemote = false;
            if (owner) {
                const val = parseInt((await this.cache.get(cacheKey) as string | undefined) ?? '0');
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
                    this.cachedChannel.client[type](cacheKey).then(() => { }).catch((err: any) => {
                        this.options?.logger?.error(err, 'Failure to replicate cache while INCR:');
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
                this.cache.set(cacheKey, "caching in progress");
            }

            const result = await (cacheable ? this.cachedChannel.client : this.client).get(cacheKey);

            if (cacheable) {
                if (result) {
                    this.cache.set(cacheKey, result);
                } else {
                    this.cache.delete(cacheKey);
                }
            } else {
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
                this.cache.set(cacheKey, "caching in progress");
            }

            const result = await (cacheable ? this.cachedChannel.client : this.client).hGetAll(cacheKey);

            if (cacheable) {
                if (result) {
                    this.cache.set(cacheKey, result);
                } else {
                    this.cache.delete(cacheKey);
                }
            } else {
            }

            return result ? result as unknown as T : null;
        } catch (err) {
            console.error(err);
            throw new Error(`Failed attempt to call GET [key=${options.key},shard=${options.shard}]`);
        }
    }

    //TODO: finish me
    async del(options: KeyOptions, stateConfig: StateConfiguration): Promise<boolean> {
        return false;
    }

    async set(options: KeyOptions, value: string | number | null, stateConfig: StateConfiguration): Promise<boolean> {
        try {
            if (value === null) {
                return this.del(options, stateConfig)
            }
            const { owner, replicated, rent } = stateConfig;
            const cacheKey = shardDecorator(options);
            let dispatchRemote = false;
            if (owner) {
                this.cache.set(cacheKey, value);
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
                    this.cachedChannel.client.set(cacheKey, value).then(() => { }).catch((err: any) => {
                        this.options?.logger?.error(err, 'Failure to replicate cache during SET');
                    });
                    return true;
                } else {
                    // For these, we will need to await the next GET:
                    await this.client.set(cacheKey, value);
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
            if (propertyTarget) {
                //Todo: implement me??
            }
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
                const hashFlattened = Object.entries(assignedRecord).flat();
                // Channel where we don't receive LOOP invalidation:
                if (owner || replicated) {
                    this.cachedChannel.client.hSet(cacheKey, hashFlattened).then(() => { }).catch((err: any) => {
                        this.options?.logger?.error({ err, assignedRecord, hashCurrent, hashRecord }, 'Failure to replicate cache during HASH SET');
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
        await Promise.all([
            await this.cachedChannel.connect(),
            await this.invalidationChannel.connect()
        ])
        // const id = (await this.invalidationChannel.client.client('ID')) //call("CLIENT ID")) as string;
        // this.options.logger.info(`Binding invalidation channel for client ${id}`);
        await this.invalidationChannel.client.subscribe('__redis__:invalidate', this.invalidateCache.bind(this));
        await new Promise((r)=>{setTimeout(r, 1000)});
        // await this.enableCache(id);
    }

    async endCacheListener() {
        await Promise.all([
            await this.cachedChannel.disconnect(),
            await this.invalidationChannel.disconnect()
        ])
        await this.invalidationChannel.client.unsubscribe('__redis__:invalidate');
    }

    invalidateCache(...args: any[]) {
        if (args[0]) {
            this.options?.logger?.warn({ args}, `Received invalidation message for ${args[0]}`);
            const invalidationKey = args[1] as string;
            if (invalidationKey === '1') {
                return;
            }
            this.cache.delete(invalidationKey);
            // If we can somehow infer a cache key from the invalidation key, we can refresh
            // but we need to accesss the state configuration for an arbitrary key to do so
        }
    }

    // These commands only work on redis protocol versions higher than supported:
    async enableCache(id: number) {
        if (await this.cachedChannel.client.clientTracking(true, { REDIRECT: id }) !== 'OK') {
            this.logger.error(Error("Cannot enable client tracking"));
        } else {
            this.logger.info(`Enabled client tracking for ID ${id}`);
        }
    }

    // async disableCache(options: KeyOptions, value: string) {
    //     const id = (await this.invalidationChannel.client.call("CLIENT ID")) as string;
    //     this.options.logger.info('CLIENT ID RESP: ', id);
    //     if (await this.cachedChannel.client.call('CLIENT TRACKING off') !== 'OK') {
    //         this.options?.logger?.error(Error("Cannot disable client tracking"));
    //     }
    // }
}
