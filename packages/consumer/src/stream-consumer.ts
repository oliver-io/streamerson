import {Transform,} from "stream";
import {EventEmitter} from 'events';
import Pino from 'pino';
import {
    ChannelTupleArray,
    IncomingChannel,
    MappedStreamEvent, NonNullablePrimitive,
    OutgoingChannel,
    StreamingDataSource,
    Topic
} from "@streamerson/core";

const moduleLogger = Pino({
    base: {
        module: 'web_api'
    },
    transport: {
        target: 'pino-pretty'
    },
});

type Handler = (e: MappedStreamEvent) => Promise<MappedStreamEvent>;

type HandlerLogicFunction = (e: MappedStreamEvent) => Record<string, NonNullablePrimitive> | Promise<Record<string, NonNullablePrimitive>>;
function handler(h: HandlerLogicFunction):Handler {
    return async function(e: MappedStreamEvent) {
        return {
            ...e,
            payload: await h(e)
        }
    }
}
export type EventMapRecord = Record<string, HandlerLogicFunction >;

export type StreamConsumerOptions<EventMap extends EventMapRecord> = {
    logger?: Pino.Logger,
    redisConfiguration?: {
        port: number,
        host: string
    }
    topic: Topic,
    shard?: string;
    bidirectional?: boolean;
    consumerGroupInstanceConfig?: {
        groupId: string,
        groupMemberId: string;
    };
    eventMap: EventMap;
}

export class StreamConsumer<
    EventMap extends EventMapRecord
> extends EventEmitter {
    topic: Topic;
    incomingChannel: StreamingDataSource;
    incomingStream: IncomingChannel;
    outgoingChannel?: StreamingDataSource;
    outgoingStream?: OutgoingChannel;
    streamEvents: Partial<Record<keyof EventMap, (e: MappedStreamEvent)=> MappedStreamEvent | Promise<MappedStreamEvent>>>;
    bidirectional?: boolean;
    public logger: Pino.Logger;
    constructor(public options: StreamConsumerOptions<EventMap>) {
        super();
        this.streamEvents = {};
        const consumerStream = this.options.topic.consumerKey(this.options.shard);
        const producerStream = this.options.topic.producerKey(this.options.shard);
        this.bidirectional = options.bidirectional ?? true;
        this.topic = options.topic ?? this.options.topic;
        this.logger = options.logger ?? this.options.logger ?? moduleLogger.child({
            shard: this.options.shard,
            meta: this.options.topic.meta(),
            streamName: consumerStream,
            destination: producerStream,
        });
        this.incomingChannel = new StreamingDataSource({
            logger: this.logger,
            controllable: true
        });

        this.incomingStream = this.incomingChannel.getReadStream({
            stream: consumerStream,
            shard: this.options.shard,
            consumerGroupInstanceConfig: this.options.consumerGroupInstanceConfig
        });
        this.bindStreamEvents(this.topic);
    }

    bindStreamEvents(topic: Topic) {
        const consumerStream = topic.consumerKey(this.options.shard);
        const producerStream = topic.producerKey(this.options.shard);
        this.outgoingChannel = this.outgoingChannel ?? (this.bidirectional ? new StreamingDataSource({
            logger: this.logger,
            controllable: true,
        }) : undefined);

        this.outgoingStream = this.outgoingStream ?? ((this.bidirectional && this.outgoingChannel) ? this.outgoingChannel.getWriteStream({
            stream: producerStream,
            shard: this.options.shard
        }) : undefined);

        for (const event in this.options.eventMap) {
            this.registerStreamEvent(event, this.options.eventMap[event]);
        }

        // create `on${streamName || label} event bindings:
        for (const [channel, label] of [
            [this.incomingStream, consumerStream],
            [this.outgoingStream, producerStream]
        ] as ChannelTupleArray) {
            if (channel) {
                if (!channel.listenerCount('error')) {
                    channel.on('error', (error: Error) => {
                        this._optionallyRouteMessage(error, `${label}Error`, 'error', 'error');
                    })
                }

                if (!channel.listenerCount('end')) {
                    channel.on('end', () => {
                        this._optionallyRouteMessage('incoming stream ending', `${label}End`, 'end', 'info');
                    })
                }

                if (!channel.listenerCount('close')) {
                    channel.on('close', () => {
                        this._optionallyRouteMessage('incoming stream closed', `${label}Close`, 'close', 'warn');
                    })
                }
            }
        }
    }

    setOutgoingChannel(channel: StreamingDataSource | null) {
        this.bidirectional = true;
        this.outgoingChannel = channel ?? undefined;
        this.bindStreamEvents(this.topic);
    }

    registerStreamEvent(
        typeKey: keyof EventMap,
        handle: EventMap[keyof EventMap]
    ) {
        this.streamEvents[typeKey] = handler(handle);
    }

    deregisterStreamEvent(typeKey: keyof EventMap) {
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

    async process(streamMessage: MappedStreamEvent) {
        if (!this.streamEvents[streamMessage.messageType]) {
            const error = new Error("No handler registered for message type: " +
                streamMessage.messageType +
                " for stream processing " +
                this.topic.consumerKey(this.options.shard)
            );
            this.logger.error(error);
            // sus-- do we want to stream the error back?  probably need to TODO: wrap this
            return error;
        };
        return await this.streamEvents[(streamMessage.messageType as keyof EventMap)]!(
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
        this.logger.warn(`DISCONNECTING client for incoming channel ${this.topic.consumerKey(this.options.shard)}`);
        this.logger.warn(`DISCONNECTING client for outgoing channel ${this.topic.producerKey(this.options.shard)}`);
        this.incomingChannel.disconnect();
        this.outgoingChannel ? this.outgoingChannel.disconnect() : null;
    }

    async connectAndListen(options?: {
        consumerGroupInstanceConfig: {
            groupId: string,
            groupMemberId: string
        }
    }) {
        await Promise.all([
            this.incomingChannel.connect(),
            this.outgoingChannel ? this.outgoingChannel.connect() : Promise.resolve()
        ]);
        this.logger.info(`Connected client for incoming channel ${this.topic.consumerKey(this.options.shard)}`);
        this.logger.info(`Connected client for outgoing channel ${this.topic.producerKey(this.options.shard)}`);

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

        if (this.outgoingStream) {
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
