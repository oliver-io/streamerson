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

/*

    type Events = 'some' | 'event'

    const x = new StreamConsumer<[ 'some', handler ]>(options);

 */

type Handler = (e: MappedStreamEvent) => MappedStreamEvent;

type HandlerLogicFunction = (e: MappedStreamEvent)=> Record<string, NonNullablePrimitive>;
function handler(h: HandlerLogicFunction):Handler {
    return function(e: MappedStreamEvent) {
        return {
            ...e,
            payload: h(e)
        }
    }
}

export class StreamConsumer<
    EventMap extends Record<string, HandlerLogicFunction >
> extends EventEmitter {
    topic: Topic;
    incomingChannel: StreamingDataSource;
    outgoingChannel?: StreamingDataSource;
    incomingStream: IncomingChannel;
    outgoingStream: OutgoingChannel;
    streamEvents: Partial<Record<keyof EventMap, (e: MappedStreamEvent)=> MappedStreamEvent>>;
    public logger: Pino.Logger;
    constructor(public options: {
        logger?: Pino.Logger,
        redisConfiguration?: {
            port: number,
            host: string
        }
        topic: Topic,
        shard?: string;
        eventMap: EventMap;
    }) {
        super();
        this.streamEvents = {};
        const consumerStream = options.topic.consumerKey(options.shard);
        const producerStream = options.topic.producerKey(options.shard);
        this.logger = options.logger ?? moduleLogger.child({
            shard: options.shard,
            meta: options.topic.meta(),
            streamName: consumerStream,
            destination: producerStream,
        });

        this.topic = options.topic;

        this.incomingChannel = new StreamingDataSource({
            logger: this.logger,
            controllable: true,
            host: '',
            port: 1234
        });

        this.incomingStream = this.incomingChannel.getReadStream({
            stream: consumerStream,
            shard: options.shard
        });

        this.outgoingChannel = new StreamingDataSource({
            logger: this.logger,
            controllable: true,
            host: '',
            port: 1234
        });

        this.outgoingStream = this.outgoingChannel.getWriteStream({
            stream: producerStream,
            shard: options.shard
        });

        // create `on${streamName || label} event bindings:
        for (const [channel, label] of [
            [this.incomingStream, consumerStream],
            [this.outgoingStream, producerStream]
        ] as ChannelTupleArray) {
            channel.on('error', (error: Error) => {
                this._optionallyRouteMessage(error, `${label}Error`, 'error', 'error');
            }).on('end', () => {
                this._optionallyRouteMessage('incoming stream ending', `${label}End`, 'end', 'info');
            }).on('close', () => {
                this._optionallyRouteMessage('incoming stream closed', `${label}Close`, 'close', 'warn');
            });
        }
    }

    setOutgoingChannel(channel: StreamingDataSource | null) {
        this.outgoingChannel = channel ?? undefined;
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

    async connectAndListen() {
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