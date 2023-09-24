import { Transform, } from "stream";
import { EventEmitter } from 'events';
import { ChannelTupleArray, IncomingChannel, MappedStreamEvent, MessageType, NullablePrimitive, OutgoingChannel, StreamMeta } from "../types";
import Pino from 'pino';
import { ApplicationState, StateConfiguration, StateTransformer, StateTransformerMap } from "./types";
import { StateCache } from "./state-cache";
import { StreamingDataSource } from "../datasources/streamable";
import { KeyOptions } from "../datasources/types";
import { StreamAwaiter } from "../streams/stream-awaiter";
import { buildStreamConfiguration, shardDecorator } from "../web/utils";
import { v4 as uuid } from 'uuid';

const moduleLogger = Pino({
    base: {
        module: 'web_api'
    },
    transport: {
        target: 'pino-pretty'
    },
});

type UserRecord = {
    id: string
}

type EventHandler<AState, T = any> = (state: StateTransformerMap<AState>, event: MappedStreamEvent<any, T>) => Promise<string | {} | null | undefined | void>

export class StreamStateMachine<
    AState extends Record<string, NullablePrimitive | { [key: string]: any }>
> extends EventEmitter {
    stateCache: StateCache<AState>;
    incomingStream: IncomingChannel;
    outgoingStream: OutgoingChannel;
    incomingStreamName: string;
    outgoingStreamName: string;
    incomingChannel: StreamingDataSource;
    outgoingChannel?: StreamingDataSource;
    transferChannel: ReturnType<typeof StreamAwaiter>
    streamEvents: Record<string, { handle: EventHandler<AState> }>
    public logger: Pino.Logger;
    public stateTransformers: StateTransformerMap<AState>;
    constructor(public options: {
        logger?: Pino.Logger,
        stateConfigurations: ApplicationState<AState>,
        redisConfiguration?: {
            port: number,
            host: string
        }
        ingestionSource: string,
        meta: StreamMeta,
        shard?: string;
        destination?: string;
    }) {
        super();

        this.logger = options.logger ?? moduleLogger.child({
            shard: options.shard,
            meta: options.meta,
            streamName: options.ingestionSource,
            destination: options.destination
        });

        // a weird little hackarino to get the worker processing the output of the other fella
        const { incomingStream: defaultOutgoingStream, outgoingStream: incomingStream, readChannel, writeChannel } = buildStreamConfiguration({
            meta: options.meta,
            streamKey: options.ingestionSource,
            redisConfiguration: options.redisConfiguration ?? {},
            channels: {
                readChannel: new StreamingDataSource(options.redisConfiguration ? {
                    ...options.redisConfiguration,
                    logger: this.logger,
                    controllable: true
                } : undefined),
                writeChannel: new StreamingDataSource(options.redisConfiguration ? {
                    ...options.redisConfiguration,
                    logger: this.logger
                } : undefined)
            }
        }, { logger: this.logger });

        const destinationStream = options.destination ? buildStreamConfiguration({
            meta: options.meta,
            streamKey: options.destination,
            redisConfiguration: {},
            channels: {
                readChannel,
                writeChannel,
            }
        }, { logger: this.logger }).outgoingStream : defaultOutgoingStream;

        this.incomingChannel = readChannel;
        this.outgoingChannel = writeChannel;
        this.incomingStreamName = incomingStream;
        this.outgoingStreamName = destinationStream;
        this.streamEvents = {};
        this.stateCache = new StateCache({
            ...options,
            logger: this.logger
        });
        this.transferChannel = StreamAwaiter({
            readChannel: new StreamingDataSource(options.redisConfiguration ? {
                ...options.redisConfiguration,
                logger: this.logger
            } : undefined),
            writeChannel: new StreamingDataSource(options.redisConfiguration ? {
                ...options.redisConfiguration,
                logger: this.logger
            } : undefined),
            incomingStream: `${shardDecorator({ key: incomingStream, shard: options.shard })}::incoming_state_transfer`
        });

        this.incomingStream = this.incomingChannel.getReadStream({
            stream: incomingStream,
            shard: options.shard
        });

        this.outgoingStream = this.outgoingChannel.getWriteStream({
            stream: destinationStream,
            shard: options.shard
        });

        // create `on${streamName || label} event bindings:
        for (const [channel, label] of [
            [this.incomingStream, incomingStream],
            [this.outgoingStream, destinationStream]
        ] as ChannelTupleArray) {
            channel.on('error', (error: Error) => {
                this._optionallyRouteMessage(error, `${label}Error`, 'error', 'error');
            }).on('end', () => {
                this._optionallyRouteMessage('incoming stream ending', `${label}End`, 'end', 'info');
            }).on('close', () => {
                this._optionallyRouteMessage('incoming stream closed', `${label}Close`, 'close', 'warn');
            });
        }

        this.stateTransformers = Object.keys(options.stateConfigurations).reduce((mappedTransformers, stateKey: keyof AState) => {
            //@ts-ignore because apparently typescript don't work too good
            mappedTransformers[stateKey] = this.getStateTransformers(stateKey);
            return mappedTransformers;
        }, { getClient: () => this.stateCache.autoCache.client } as unknown as StateTransformerMap<AState>);
    }

    setOutgoingChannel(channel: StreamingDataSource | null) {
        this.outgoingChannel = channel ?? undefined;
    }

    registerStreamEvent<T>(
        typeKey: string,
        handle: EventHandler<AState, T>
    ) {
        this.streamEvents[typeKey] = { handle };
    }

    deregisterStreamEvent(typeKey: string) {
        delete this.streamEvents[typeKey];
    };

    addStream(key: string) {
        this.logger.info({ key }, 'ADDING STREAM TO LISTENING CHANNEL');
        this.incomingChannel.addStreamId(key);
    };

    hasStream(key: string) {
        return this.incomingChannel.hasStreamId(key);
    }

    removeStream(key: string) {
        this.incomingChannel.removeStreamId(key);
    };

    cacheComposite(cacheKey: string) {
        return {
            key: cacheKey,
            shard: this.options.shard ?? undefined
        }
    };

    async getRaw(propertyTarget: string, value?: string, useShard: boolean = true) {
        return await this.stateCache.get(
            propertyTarget,
            useShard ? this.cacheComposite(value ?? propertyTarget) :
                { key: value ?? propertyTarget }
        );
    };

    async setRaw(propertyTarget: string, value: string | number, user?: { id: string }, useShard: boolean = true) {
        return await this.stateCache.set(
            propertyTarget,
            useShard ? this.cacheComposite(propertyTarget ?? propertyTarget) : { key: propertyTarget },
            value
        );
    };

    getStateTransformers(stateTarget: keyof AState): StateTransformer {
        const stateConf: StateConfiguration = this.options.stateConfigurations[stateTarget];
        const keyFunction = Object.prototype.hasOwnProperty.call(stateConf, 'dataKey');
        return {
            incr: async (propertyTarget: string, context?: { message: MappedStreamEvent, user: UserRecord }) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return await this.atomicallyIncrementState(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
            },
            decr: async (propertyTarget: string, context?: { message: MappedStreamEvent, user: UserRecord }) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return await this.atomicallyDecrementState(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
            },
            get: async (propertyTarget: string, context?: { message: MappedStreamEvent, user: UserRecord }, useShard: boolean = true) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return await this.stateCache.get(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
            },
            set: async (propertyTarget: string, value: string | number | null, context?: { message: MappedStreamEvent, user: UserRecord }, useShard: boolean = true) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return await this.stateCache.set(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), value);
            },
            getHash: async (propertyTarget: string, context?: { message: MappedStreamEvent, user: UserRecord }, useShard: boolean = true) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return this.stateCache.getHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
            },
            setHash: async (propertyTarget: string, valueOrPropertyTarget: string | {}, value?: {}, context?: { message: MappedStreamEvent, user: UserRecord }, useShard: boolean = true) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                return this.stateCache.setHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), valueOrPropertyTarget, value);
            },
            transfer: async (propertyTarget: string, shardTarget: string, context?: { message: MappedStreamEvent, user: UserRecord }) => {
                const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
                if (this.stateCache.has(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget))) {
                    const stateToTransfer = {
                        stateType: stateTarget,
                        stateData: await this.stateCache.get(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget))
                    }
                    return !!(await this.transferChannel.dispatch(JSON.stringify(stateToTransfer), MessageType.TRANSFER, shardTarget, 'transfer'));
                } else {
                    throw new Error(`State ${stateTarget as string}::${cacheKey} is not locally held`);
                }
            },
            broadcast: async (toStream, payload, sourceId) => {
                await this.outgoingChannel?.writeToStream(
                    toStream,
                    null,
                    MessageType.BROADCAST,
                    uuid(),
                    JSON.stringify(payload),
                    sourceId
                );
            }
        }
    }

    async atomicallyIncrementState(stateTarget: keyof AState, keyOptions: KeyOptions) {
        // Debug print of first value -- not a get&operate:
        const val0 = await this.stateCache.get(stateTarget, keyOptions);
        console.log('===========INCR==VAL0 (MAYBE STALE):', val0);
        const val1 = await this.stateCache.incr(stateTarget, keyOptions);
        console.log('===========INCR==VALP', val1);
        return val1;
    }

    async atomicallyDecrementState(stateTarget: keyof AState, keyOptions: KeyOptions) {
        // Debug print of first value, not a get&operate:
        const val0 = await this.stateCache.get(stateTarget, keyOptions);
        console.log('===========DECR==VAL0 (MAYBE STALE):', val0);
        const val1 = await this.stateCache.decr(stateTarget, keyOptions);
        console.log('===========DECR==VALP', val1);
        return val1;
    }

    async process(streamMessage: MappedStreamEvent) {
        if (!this.streamEvents[streamMessage.messageType]) {
            const error = new Error("No handler registered for message type: " +
                streamMessage.messageType +
                " for stream processing " +
                this.incomingStreamName
            );
            this.logger.error(error);
            return error;
        };
        return await this.streamEvents[streamMessage.messageType].handle(
            this.stateTransformers,
            {
                ...streamMessage,
                payload: 
                    typeof streamMessage.payload === 'object' ? 
                        streamMessage.payload : 
                        JSON.parse(streamMessage.payload as unknown as string | undefined ?? 'null')
            }
        );
    }

    async disconnect() {
        this.logger.warn(`DISCONNECTING client for incoming channel ${this.incomingStreamName}`);
        this.logger.warn(`DISCONNECTING client for outgoing channel ${this.outgoingStreamName}`);
        this.stateCache.disconnect();
        this.incomingChannel.disconnect();
        this.outgoingChannel ? this.outgoingChannel.disconnect() : null;
    }

    async connectAndListen() {
        await Promise.all([
            this.stateCache.connect(),
            this.incomingChannel.connect(),
            this.outgoingChannel ? this.outgoingChannel.connect() : Promise.resolve()
        ]);
        this.logger.info(`Connected client for incoming channel ${this.incomingStreamName}`);
        this.logger.info(`Connected client for outgoing channel ${this.outgoingStreamName}`);

        const setState = async (streamMessage: MappedStreamEvent) => {
            return await this.process(streamMessage);
        }

        const logger = this.logger;

        const incomingPipe = this.incomingStream.pipe(new Transform({
            transform: function (object, _, callback) {
                try {
                    console.log('RECEIVED A MESSAGE FROM THE FREAKIN THING', object);
                    if (object) {
                        setState(object).then((message) => {
                            this.push({
                                messageId: object.messageId,
                                payload: message
                            });
                            callback();
                        }).catch(err => {
                            logger.error(err, 'Cannot transform state in stream');
                        });
                    }
                } catch (err) {
                    this.push('Generic Error Response cijkdcjidkfj');
                    callback();
                }
            },
            objectMode: true
        }));

        if (this.outgoingChannel) {
            incomingPipe.pipe(this.outgoingStream);
        }
    }

    private _optionallyRouteMessage(event: any, primaryEvent: string, fallbackEvent: string, logClass: 'error' | 'info' | 'warn') {
        if (this.listeners(primaryEvent).length) {
            this.emit(primaryEvent, event);
        } else if (this.listeners(fallbackEvent).length) {
            this.emit(fallbackEvent, event);
        } else {
            this.logger[logClass](event);
        }
    }
}