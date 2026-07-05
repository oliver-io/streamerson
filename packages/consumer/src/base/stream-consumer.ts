import { Transform } from 'stream';
import { EventEmitter } from 'events';
import {
  ChannelTupleArray,
  createStreamersonLogger,
  IncomingChannel,
  MappedStreamEvent,
  MessageType,
  NonNullablePrimitive,
  NullablePrimitive,
  OutgoingChannel,
  StreamersonLogger,
  StreamingDataSource,
  Topic,
  TopicOptions
} from '@streamerson/core';

const moduleLogger = createStreamersonLogger({
  module: 'streamerson_consumer'
});

export type PayloadVariety = Record<string, NullablePrimitive>;

type StreamHandlerEvent<
  T extends PayloadVariety
> = Omit<MappedStreamEvent, 'payload'> & { payload: T };

type HandlerLogicFunction<
  T extends PayloadVariety,
  R extends (PayloadVariety | void)
> = (e: StreamHandlerEvent<T>) => Promise<R> | R;

export type EventMapRecord<T extends PayloadVariety, R extends PayloadVariety> = Record<string, HandlerLogicFunction<T, R>>;

export type StreamConsumerOptions<EventMap extends EventMapRecord<Record<string, NullablePrimitive>, any>> = {
  logger?: StreamersonLogger,
  redisConfiguration?: {
    port?: number,
    host?: string
  }
  topic: Topic | TopicOptions,
  shard?: string;
  bidirectional?: boolean;
  consumerGroupInstanceConfig?: {
    groupId: string,
    groupMemberId: string;
  };
  /** XREADGROUP BLOCK cadence, ms (consumer-group member loop). Default 100. */
  blockTimeout?: number;
  /** Messages pulled per read (consumer-group member loop). Default 1. */
  prefetch?: number;
  /** Abandonment grace / reclaim idle threshold, ms (consumer-group member). `0` disables reclaim. */
  processingTimeout?: number;
  /** Opt-in retry (consumer-group member): at-least-once, idempotent handlers required. */
  retry?: { maxAttempts: number };
  eventMap?: EventMap;
}

/**
 * @class StreamConsumer
 * @description A Consumer-Producer to process and produce stream events
 */
export class StreamConsumer<
  EventMap extends EventMapRecord<any, any>
> extends EventEmitter {
  topic: Topic;
  incomingChannel: StreamingDataSource;
  incomingStream: IncomingChannel;
  outgoingChannel?: StreamingDataSource;
  outgoingStream?: OutgoingChannel;
  streamEvents: Partial<Record<keyof EventMap, (e: MappedStreamEvent) => Promise<PayloadVariety>>>;
  bidirectional?: boolean;
  public logger: StreamersonLogger;

  constructor(public options: StreamConsumerOptions<EventMap>) {
    super();
    this.streamEvents = {};
    this.topic = options.topic instanceof(Topic) ? options.topic : new Topic(options.topic);
    const consumerStream = this.topic.consumerKey(this.options.shard);
    const producerStream = this.topic.producerKey(this.options.shard);
    this.bidirectional = options.bidirectional ?? true;
    this.logger = createStreamersonLogger({
      shard: this.options.shard,
      ...this.topic.meta(),
      streamName: consumerStream,
      destination: producerStream
    }, (options.logger ?? this.options.logger ?? moduleLogger));

    this.incomingChannel = new StreamingDataSource({
      host: this.options.redisConfiguration?.host,
      port: this.options.redisConfiguration?.port,
      logger: this.logger as any,
      controllable: true
    });

    // `consumerStream` is already shard-decorated (topic.consumerKey(shard)); core's
    // shardDecorator contract is "undecorated key + shard" OR "pre-decorated key, no
    // shard" (cf. stream-awaiter.ts readResponseStream). Passing `shard` again would
    // double-decorate and leave a sharded consumer reading a key nobody writes (A8).
    this.incomingStream = this.incomingChannel.getReadStream({
      stream: consumerStream,
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
      host: this.options.redisConfiguration?.host,
      port: this.options.redisConfiguration?.port
    }) : undefined);

    // `producerStream` is already shard-decorated — no `shard` here (see A8 note above).
    this.outgoingStream = this.outgoingStream ?? ((this.bidirectional && this.outgoingChannel) ? this.outgoingChannel.getWriteStream({
      stream: producerStream
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
          });
        }

        if (!channel.listenerCount('end')) {
          channel.on('end', () => {
            this._optionallyRouteMessage('incoming stream ending', `${label}End`, 'end', 'info');
          });
        }

        if (!channel.listenerCount('close')) {
          channel.on('close', () => {
            this._optionallyRouteMessage('incoming stream closed', `${label}Close`, 'close', 'warn');
          });
        }
      }
    }
  }

  /**
   * Bind an `MessageType` to a handler function
   * @param typeKey the `MessageType` to bind
   * @param handle the handler function to bind to the `MessageType`
   */
  registerStreamEvent<
    T extends PayloadVariety = Record<string, NonNullablePrimitive>,
    R extends (PayloadVariety | void) = Record<string, NonNullablePrimitive>
  >(
    typeKey: keyof EventMap,
    handle: HandlerLogicFunction<T, R>
  ) {
    this.streamEvents[typeKey] = (handle as unknown as typeof this.streamEvents[keyof EventMap]);
  }

  deregisterStreamEvent(typeKey: keyof EventMap) {
    delete this.streamEvents[typeKey];
  };

  addStream(key: string) {
    this.logger.info({ key }, 'Adding stream to listening channel');
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
    };
  };

  get _handle_message() {
    return (async (streamMessage: MappedStreamEvent): Promise<MappedStreamEvent> => {
      return {
        ...streamMessage,
        messageType: 'resp' as MessageType,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        payload: await this.streamEvents[streamMessage.messageType]!(
          {
            ...streamMessage,
            payload:
              typeof streamMessage.payload === 'object' ?
                streamMessage.payload :
                JSON.parse(streamMessage.payload as unknown as string | undefined ?? 'null')
          }
        )
      };
    })
  }

  async process(streamMessage: MappedStreamEvent) {
    if (!this.streamEvents[streamMessage.messageType]) {
      const error = new Error('No handler registered for message type: ' +
        streamMessage.messageType +
        ' for stream processing ' +
        this.topic.consumerKey(this.options.shard)
      );
      this.logger.error(error);
      // sus-- do we want to stream the error back?  probably need to TODO: wrap this
      return error;
    }

    return await this._handle_message(streamMessage);
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

    // Pin the read cursor to the stream's current tip BEFORE resolving (the Q9/GW15
    // pattern, cf. stream-awaiter.readResponseStream): the constructor's reader is
    // armed with '$', which is resolved only at its FIRST XREAD — after this method
    // returns — so a message written immediately after connectAndListen() resolves
    // could land in the arm-up gap and be skipped forever (A9). The constructor's
    // Readable has never been pulled (it is only piped below), so it holds no read
    // loop or listeners of its own; replace it with one seeded at the captured tip
    // and re-run the channel-event binding for the new instance.
    const consumerStream = this.topic.consumerKey(this.options.shard);
    this.incomingStream = this.incomingChannel.getReadStream({
      stream: consumerStream,
      last: await this.incomingChannel.currentTopId(consumerStream),
      consumerGroupInstanceConfig: this.options.consumerGroupInstanceConfig
    });
    this.bindStreamEvents(this.topic);

    this.logger.info({
      incoming: this.topic.consumerKey(this.options.shard),
      outgoing: this.topic.producerKey(this.options.shard),
      ...(options?.consumerGroupInstanceConfig ?? {})
    }, 'Connecting consumer client');

    const setState = async (streamMessage: MappedStreamEvent) => {
      const post = await this.process(streamMessage);
      return post
    };

    const logger = this.logger;

    const incomingPipe = this.incomingStream.pipe(new Transform({
      transform(object, _, callback) {
        if (!object) return callback();
        setState(object).then((message) => {
          this.push(message);
          callback();
        }).catch((err) => {
          // Never wedge the pipeline (CG-G2): log and advance. The single-consumer
          // path has no ack to corrupt; the group member's bounded loop owns the
          // at-most-once / recoverable-failure contract (REQUEST_STREAM_RECEIPT.md §5).
          logger.error(err, 'Stream handler failed; skipping message');
          callback();
        });
      },
      objectMode: true
    }));

    if (this.outgoingStream) {
      incomingPipe.pipe(this.outgoingStream);
    }
  }

  async produceMessage(options: {
    messageId: string,
    messageType: string,
    message: Record<string, NullablePrimitive>,
    sourceId: string,
    shard?: string
  }) {
    await this.outgoingChannel?.writeToStream({
      outgoingStream: this.topic.producerKey(),
      incomingStream: undefined,
      messageType: options.messageType as MessageType,
      messageId: options.messageId,
      message: JSON.stringify(options.message),
      sourceId: this.topic.consumerKey(),
      shard: options.shard
    });
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
