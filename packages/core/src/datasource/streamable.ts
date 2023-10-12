import {Readable, Writable} from 'stream';
import {
  type BlockingStreamBatchMapOptions,
  type KeyOptions,
  type MappedStreamEvent,
  MaybeConsumerGroupInstanceConfig,
  type MessageId,
  MessageType,
  type StreamableDataSource,
  type StreamEventData,
  type StreamId,
  type StreamResponseArray,
} from '../types';
import {HOURS_TO_MS} from '../utils/time';
import {Topic} from '../utils/topic';
import {RedisDataSource} from './base/remote';
import {EventEmitter} from 'events';
import {shardDecorator} from '../utils/keys';

export enum MessageHeaderIndex {
  ID,
  TYPE,
  DESTINATION,
  HEADERS,
  CONTENT_TYPE,
  SOURCE_ID,
  UNUSED,
  PAYLOAD,
}

enum KeyEvents {
  ADD_STREAM = 'addStream',
  REMOVE_STREAM = 'removeStream',
  UPDATE = 'update',
}

const DEFAULT_BLOCKING_TIMEOUT = HOURS_TO_MS(0.5);

export type GetReadStreamOptions = {
  stream: string;
  shard?: string;
  last?: string;
  requestedBatchSize?: number;
  blockingTimeout?: number;
} & MaybeConsumerGroupInstanceConfig

/**
 * A remote source capable of retrieving stream records from a Redis instance.
 *
 * @constructor options: DataSourceOptions
 *
 * @beta
 */
export class StreamingDataSource

  extends RedisDataSource
  implements StreamableDataSource {
  streamIdMap: Record<StreamId, number> = {};
  keyEvents: EventEmitter = new EventEmitter();
  responseType: MessageType = MessageType.RESPONSE;

  /**
   @param outgoingStream: The stream ID to target in Redis
   @param incomingStream: Maybe, a stream ID to reply to
   @param messageType: The type of the event
   @param messageId: The ID of the message
   @param message: The message payload
   @param sourceId: The ID of the source
   @param shard: Maube, the shard to target
   */
  public async writeToStream(
    outgoingStream: StreamId,
    incomingStream: StreamId | undefined,
    messageType: MessageType,
    messageId: MessageId,
    message: string,
    sourceId: string,
    shard?: string,
  ) {
    try {
      console.time('Dispatch writeToStream to Redis');
      const result = this.client.xadd(
        shardDecorator({key: outgoingStream, shard}),
        '*',
        messageId, // MessageId
        messageType, // Message packing; TODO: Make this configurable
        incomingStream ?? '', // MessageDestination
        'nil', // Message headers
        'json', // Label for caution and pack type
        sourceId,
        'UnoccupiedField',
        message, // Payload
      );
      console.timeEnd('Dispatch writeToStream to Redis');
      return await result;
    } catch (err) {
      this.options.logger.error(err);
      throw new Error(
        `Failed attempt to call XADD [key=${outgoingStream},response=${incomingStream}, shard=${shard}, message=${message}]`,
      );
    }
  }

  setResponseType(type: string) {
    this.responseType = type as MessageType;
  }

  addStreamId(streamId: StreamId) {
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
    this.streamIdMap[streamId] = Date.now();
  }

  hasStreamId(streamId: StreamId) {
    return Boolean(this.streamIdMap[streamId]);
  }

  removeStreamId(streamId: StreamId) {
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
    delete this.streamIdMap[streamId];
  }

  private deserializeMessageArray(
    rawEvent: StreamEventData,
    _streamTitle: string,
  ) {
    const [_id, properties] = rawEvent;
    this.options.logger.info('DESERIALIZING: ', rawEvent);
    const eventMap: MappedStreamEvent = {
      streamId: _streamTitle,
      streamMessageId: _id,
      messageId: properties[MessageHeaderIndex.ID],
      messageType: properties[MessageHeaderIndex.TYPE],
      messageDestination: properties[MessageHeaderIndex.DESTINATION],
      messageProtocol: properties[MessageHeaderIndex.CONTENT_TYPE],
      messageSourceId: properties[MessageHeaderIndex.SOURCE_ID],
      payload: {},
    };
    if (
      properties[MessageHeaderIndex.HEADERS]
      && properties[MessageHeaderIndex.HEADERS] !== 'nil'
    ) {
      eventMap.messageHeaders = JSON.parse(
        Buffer.from(properties[MessageHeaderIndex.HEADERS]).toString(),
      );
    }

    eventMap.payload
      = properties[MessageHeaderIndex.CONTENT_TYPE] === 'json'
      ? JSON.parse(properties[MessageHeaderIndex.PAYLOAD] as string)
      : (properties[MessageHeaderIndex.PAYLOAD] as string);

    if (!eventMap.messageId) {
      this.options.logger.error('MAP', eventMap);
      this.options.logger.error('PROPS', properties);
      throw new Error('No Message ID in Message');
    }

    return eventMap;
  }

  //XGROUP CREATE key group <id | $> [MKSTREAM]
  async createConsumerGroup(config: {
    stream: string,
    groupId: string,
    cursor?: string
  }) {
    return await new Promise((resolve, reject) => {
      try {
        this.client.xgroup("CREATE", config.stream, config.groupId, (config.cursor ?? "$") as "$", resolve)
      } catch (err) {
        reject(err);
      }
    });
  }

  // This needs to be executed if we want to do consumer group reads from a stream without data in it already
  // consider doing some `INFO` operations on the stream?
  // we might want to throw errors if we try to read from a stream without data that hasn't called this fn
  async createGroupMember(config: {
    stream: string,
    groupId: string,
    groupMemberId: string,
    cursor?: string
  }) {
    return await new Promise((resolve, reject) => {
      try {
        this.client.xgroup("CREATECONSUMER", config.stream, config.groupId, config.groupMemberId, resolve)
      } catch (err) {
        reject(err);
      }
    });
  }

  async readAsSingle(stream: string, cursor: string, timeout: number) {
    return (await this.client.call(
      'XREAD',
      'BLOCK',
      timeout,
      // "COUNT", 10,
      'STREAMS',
      stream,
      cursor,
    ) ?? []) as Array<[
      StreamId,
      Array<[_id: string, messaage: StreamResponseArray]>,
    ]>;
  }

  async readAsGroup(
    stream: string,
    cursor: string,
    groupName: string,
    groupMemberId: string,
    timeout: number
  ) {
    return (await this.client.call(
      'XREADGROUP',
      'GROUP',
      groupName,
      groupMemberId,
      'BLOCK',
      timeout,
      // "COUNT", 10,
      'STREAMS',
      stream,
      cursor,
    ) ?? []) as Array<[
      StreamId,
      Array<[_id: string, messaage: StreamResponseArray]>,
    ]>;
  }

  async blockingStreamBatchMap(options: BlockingStreamBatchMapOptions) {
    const {logger} = this.options;
    try {
      if (options.stream && typeof options.last === 'string') {
        let cursor = options.last ?? '$';
        const stream = shardDecorator({
          key: options.stream,
          shard: options.shard,
        });
        logger.info(
          `(Re)initiating Redis stream ${stream} read from key ${cursor}`,
        );
        const events: MappedStreamEvent[] = [];
        const streamEvents = await (options.consumerGroupInstanceConfig ?
            this.readAsGroup(
              stream,
              // TODO: in a failure recovery case, this needs to be the relevant ID,
              // but it needs to be handled differently from the single stream cursor
              cursor ? '>' : '',
              options.consumerGroupInstanceConfig.groupId,
              options.consumerGroupInstanceConfig.groupMemberId,
              options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT
            ) :
            this.readAsSingle(
              stream,
              cursor,
              options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT
            )
        );

        for (const [_streamTitle, entries] of streamEvents ?? []) {
          for (const rawEvent of entries) {
            events.push(this.deserializeMessageArray(rawEvent, _streamTitle));
            cursor = rawEvent[0];
          }
        }

        if (events.length) {
          logger.info(
            `Returning ${events.length} events from batch, last key ${cursor}`,
          );
        }

        return {
          cursor,
          events,
        };
      }

      if (!options.stream && typeof options.last === 'object') {
        logger.info({options}, 'ENGAGING IN MULTISTREAM MODE');
        const cursor = options.last;
        // Multistream mode:
        const streamKeys = Object.keys(this.streamIdMap);
        if (!streamKeys.length) {
          throw new Error(
            'blockingStreamBatchMap: No streams to read from list of stream IDs',
          );
        }

        const streamsWithCursors: string[] = [];
        streamsWithCursors.push(
          ...streamKeys,
          ...streamKeys.map(s => cursor[s] ?? '$'),
        );
        const events: MappedStreamEvent[] = [];
        const args: Array<string | number> = [
          'XREAD',
          'BLOCK',
          options.blockingTimeout ?? HOURS_TO_MS(0.5),
          'STREAMS',
          ...streamsWithCursors,
        ];

        logger.info(
          {arguments: args.join(' ')},
          '(Re)initiating COMPOSITE Redis stream',
        );
        const streamEvents = ((await this.client.call(
          'XREAD',
          'BLOCK',
          options.blockingTimeout ?? HOURS_TO_MS(0.5),
          'STREAMS',
          ...streamsWithCursors,
        )) ?? []) as Array<[
          StreamId,
          Array<[_id: string, messaage: StreamResponseArray]>,
        ]>;
        logger.info({streamEvents}, 'COMPOSITE Redis stream RESULTS!');

        for (const [_streamTitle, entries] of streamEvents ?? []) {
          for (const rawEvent of entries) {
            events.push(this.deserializeMessageArray(rawEvent, _streamTitle));
            cursor[_streamTitle] = rawEvent[0];
          }
        }

        if (events.length) {
          logger.info(
            `Returning ${events.length} events from batch, last key ${cursor}`,
          );
        }

        return {
          cursor,
          events,
        };
      }

      throw new Error('Unrecognized control flow for blockingStreamBatchMap');
    } catch (err) {
      logger.error(err);
      throw new Error(
        `Failed attempt to call XREAD [key=${options.stream},shard=${options.shard}]`,
      );
    }
  }

  getReadStream(options: { topic: Topic, shard?: string } | GetReadStreamOptions) {
    this.addStreamId('topic' in options ? options.topic.consumerKey(options.shard) : options.stream);
    return Readable.from(this.iterateStream(options), {
      objectMode: true,
    }) as Readable & { readableObjectMode: true };
  }

  getWriteStream(options: { topic: Topic, shard?: string } | {
    stream: string;
    responseChannel?: string;
    shard?: string;
  }): Writable & { writableObjectMode: true } {
    return new Writable({
      objectMode: true,
      write: async (chunk: MappedStreamEvent, _, callback) => {
        if (!chunk.messageId || !chunk.payload) {
          this.options.logger.warn(
            `Dropping message with no messageId or payload: ${chunk}`,
          );
          return;
        }

        const incomingStreamName = 'topic' in options ? options.topic.consumerKey(options.shard) : options.stream;
        const outgoingStreamName = 'topic' in options ? options.topic.producerKey(options.shard) : options.responseChannel;

        const {messageId, payload} = chunk;
        this.options.logger.info({payload}, '\r\n\r\nRESP Payload\r\n\r\n');
        await this.writeToStream(
          incomingStreamName,
          outgoingStreamName,
          MessageType.RESPONSE,
          messageId,
          JSON.stringify(payload),
          chunk.messageSourceId,
          options.shard,
        );
        callback();
      },
    }) as Writable & { writableObjectMode: true };
  }

  async get(key: string, shard?: string) {
    try {
      return await this.client.get(shardDecorator({key, shard})) ?? undefined;
    } catch (err) {
      this.options.logger.error(err);
      throw new Error(`Failed attempt to call GET [key=${key},shard=${shard}]`);
    }
  }

  async incr(key: string, shard?: string) {
    try {
      return await this.client.incr(shardDecorator({key, shard})) ?? undefined;
    } catch (err) {
      this.options.logger.error(err);
      throw new Error(`Failed attempt to call INCR [key=${key},shard=${shard}]`);
    }
  }

  async set(options: KeyOptions, value: string) {
    try {
      if (!value) {
        throw new Error('Cannot SET to empty strings, use DELETE');
      }

      return (await this.client.set(shardDecorator(options), value)) === 'OK';
    } catch (err) {
      this.options.logger.error(err);
      throw new Error(
        `Failed attempt to call SET [key=${options.key}, shard=${options.shard}, value=${value}]`,
      );
    }
  }

  async markProcessedByGroup(
    topic: Topic,
    groupId: string,
    messageId: string,
    shard?: string
  ) {
    const ack = this.client.xack(topic.consumerKey(shard), groupId, messageId)
    if (!ack) {
      throw new Error(`Failed to ack message ${messageId} for group ${groupId}`)
    }
  }

  private async* iterateStream(options: {
    stream?: string;
    shard?: string;
    last?: string | Record<string, string>;
    requestedBatchSize?: number;
    blockingTimeout?: number;
  }) {
    let hasNewStreams = false;
    const args = {
      ...options,
      last: options.last ?? (options.stream ? '$' : {}),
    };

    const refreshStreams = () => {
      this.options.logger.info({options, args}, 'Refreshing streams');
      hasNewStreams = true;
    };

    this.keyEvents.on(KeyEvents.UPDATE, refreshStreams);

    do {
      if (hasNewStreams) {
        delete args.stream;
        hasNewStreams = false;
        if (typeof args.last === 'string' && options.stream) {
          args.last = {[options.stream]: args.last};
        }
      }

      const raced = await Promise.race<{
        cursor?: string | Record<string, string>;
        events: MappedStreamEvent[];
      }>([
        this.blockingStreamBatchMap(args),
        new Promise(r => {
          this.keyEvents.once(KeyEvents.UPDATE, r);
        }),
      ]);

      if (!raced.cursor) {
        this.options.logger.info(
          'Aborted early from stream, terminating pending connections',
        );
        await this.abort();
        continue;
      }

      // TODO: Set the last key in the remote store for recovery?
      args.last = raced.cursor;
      for (const event of raced.events) {
        yield event;
      }
    } while (true);
  }
}
