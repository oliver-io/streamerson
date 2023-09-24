import { ApplicationState } from "./types";
import { CacheableDataSource } from "../datasources/cacheable";
import Pino, { Logger } from 'pino';
import { KeyOptions } from "../datasources/types";

const moduleLogger = Pino({
    base: {
        module: 'web_api'
    },
    transport: {
        target: 'pino-pretty'
    },
});


export class StateCache<AState> {
    stateConfigurations: ApplicationState<AState>
    autoCache: CacheableDataSource;
    constructor({ stateConfigurations, redisConfiguration, logger }: {
        logger: Logger,
        stateConfigurations: ApplicationState<AState>, 
        redisConfiguration?: {
            host: string,
            port: number,
            logger?: typeof moduleLogger
        }
    }) {
        const {
            host = 'localhost',
            port = 6379
        } = redisConfiguration ?? {};
        this.stateConfigurations = stateConfigurations;
        this.autoCache = new CacheableDataSource({
            host, port, logger: logger ?? redisConfiguration?.logger ?? moduleLogger
        });
    }

    async connect() {
        await this.autoCache.beginCacheListener();
        return await this.autoCache.connect();
    }

    async disconnect() {
        await this.autoCache.endCacheListener();
        return await this.autoCache.disconnect();
    }

    getHash(
        type: keyof AState, 
        key: KeyOptions
    ) {
        return this.autoCache.getHash(key, this.stateConfigurations[type]);
    }
    setHash(
        type: keyof AState, 
        key: KeyOptions,
        valueOrKey: string | {},
        value?: {} | null
    ) {
        return this.autoCache.setHash(key, valueOrKey, value ?? null, this.stateConfigurations[type]);
    }
    async get(type: keyof AState, key: KeyOptions) {
        return await this.autoCache.get(
            key,
            this.stateConfigurations[type]
        );
    }

    async incr(type: keyof AState, key: KeyOptions) {
        return await this.autoCache.incr(key, this.stateConfigurations[type]);
    }

    async decr(type: keyof AState, key: KeyOptions) {
        return await this.autoCache.decr(key, this.stateConfigurations[type]);
    }

    async set(type: keyof AState, key: KeyOptions, value: string | number | null) {
        // TODO: handle null case as delete
        return await this.autoCache.set(
            key,
            value,
            this.stateConfigurations[type]
        );
    }

    has(type: keyof AState, key: KeyOptions) {
        return this.autoCache.has(key, this.stateConfigurations[type]);
    }
}