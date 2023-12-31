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
  CANCEL = 'abort'
}

const DEFAULT_BLOCKING_TIMEOUT = HOURS_TO_MS(0.5);
const DEFAULT_MAX_BATCH_SIZE = 10;

export type GetReadStreamOptions = {
  stream: string;
  shard?: string;
  last?: string;
  requestedBatchSize?: number;
  blockingTimeout?: number;
} & MaybeConsumerGroupInstanceConfig

/**
 * A remote source capable of retrieving stream records from a Redis instance.
 * @constructor options {DataSourceOptions}: the options controlling streaming behavior for this source
 * @beta
 */
export class StreamingDataSource

  extends RedisDataSource
  implements StreamableDataSource {
  streamIdMap: Record<StreamId, number> = {};
  keyEvents: EventEmitter = new EventEmitter();
  responseType: MessageType = MessageType.RESPONSE;

  /**
   * A low-level implementation wrapping a Redis Stream Write operation
   *
   @param outgoingStream The stream ID to target in Redis
   @param incomingStream Maybe, a stream ID to reply to
   @param messageType The type of the event
   @param messageId The ID of the message
   @param message The message payload
   @param sourceId The ID of the source
   @param shard Maybe, the shard to target
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
      this.logger.debug({outgoingStream, incomingStream, messageType, messageId, message, sourceId, shard}, 'Dispatching message to stream')
      const result = this.client.xadd(
        shardDecorator({key: outgoingStream, shard}),
        '*',
        messageId, // MessageId
        this.responseType ?? messageType,
        incomingStream ?? '', // MessageDestination
        'nil', // Message headers
        'json', // Label for caution and pack type
        sourceId,
        'UnoccupiedField',
        message, // Payload
      );
      return await result;
    } catch (err) {
      this.logger.error(err);
      throw new Error(
        `Failed attempt to call XADD [key=${outgoingStream},response=${incomingStream}, shard=${shard}, message=${message}]`,
      );
    }
  }

  /**
   * Sets the `MessageType` field default for outgoing messages
   * @param type The `MessageType` for outgoing messages
   */
  setResponseType(type: string) {
    this.responseType = type as MessageType;
  }

  /**
   * Adds a stream to the set for consumption
   * @param streamId the key of the stream to ingest
   */
  addStreamId(streamId: StreamId) {
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
    this.streamIdMap[streamId] = Date.now();
  }

  /**
   * Checks whether a stream is set for consumption
   * @param streamId the key of the stream to check
   */
  hasStreamId(streamId: StreamId) {
    return Boolean(this.streamIdMap[streamId]);
  }

  /**
   * Removes a stream from the set for consumption
   * @param streamId the key of the stream to remove
   */
  removeStreamId(streamId: StreamId) {
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
    delete this.streamIdMap[streamId];
  }

  /**
   * Private function that converts a Redis message to a MappedStreamEvent
   * @param rawEvent the raw event from Redis as a tuple-tuple
   * @param _streamTitle the title of the stream from whence the message came
   * @private
   */
  private deserializeMessageArray(
    rawEvent: StreamEventData,
    _streamTitle: string,
  ) {
    this.logger.debug(rawEvent, 'Raw stream event!');
    try {
      const [_id, properties] = rawEvent;
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
        this.logger.error('MAP', eventMap);
        this.logger.error('PROPS', properties);
        throw new Error('No Message ID in Message');
      }

      return eventMap;
    } catch(err) {
      this.logger.error(err);
      console.error(err);
      throw err;
    }
  }

  /**
   * @typedef ConsumerGroupConfig
   * @type {object}
   * @property {string} stream - a stream ID
   * @property {string} groupId - a consumer group key that tracks the stream
   * @property {string} [cursor] - a cursor from which to begin tracking
   * Create a consumer group in the remote Redis for tracked consumption of a streams
   * @param config {ConsumerGroupConfig}
   */
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
  /**
  * @typedef ConsumerGroupMemberConfig
  * @type {object}
  * @property {string} stream - a stream ID
   * @property {string} groupId - a consumer group key that tracks the stream
   * @property {string} groupMemberId - a member ID that tracks messages within the consumer group
  * @property {string} [cursor] - a cursor from which to begin tracking
  * Create a consumer group in the remote Redis for tracked consumption of a streams
  * Create a consumer group in the remote Redis for tracked consumption of a streams
  * @param config {ConsumerGroupMemberConfig}
  */
  async createGroupMember(config: {
    stream: string,
    groupId: string,
    groupMemberId: string,
    cursor?: string
  }) {
    // This needs to be executed if we want to do consumer group reads from a stream without data in it already
    // consider doing some `INFO` operations on the stream?
    // we might want to throw errors if we try to read from a stream without data that hasn't called this fn
    return await new Promise((resolve, reject) => {
      try {
        this.client.xgroup("CREATECONSUMER", config.stream, config.groupId, config.groupMemberId, resolve)
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Read a message or batch from a stream as a single consumer rather than a part of a group
   * @param stream the key of the stream from which to read
   * @param cursor the cursor from which to begin reading
   * @param timeout the timeout in milliseconds to wait for a message
   * @param batchSize the number of messages to read
   */
  async readAsSingle(stream: string, cursor: string, timeout: number, batchSize = 1) {
    return (await this.client.xread(
      'BLOCK' as any,
      timeout,
      "COUNT",
      batchSize,
      'STREAMS',
      stream,
      cursor,
    ) ?? []) as Array<[
      StreamId,
      Array<[_id: string, message: StreamResponseArray]>,
    ]>;
  }

  /**
   * Read a message or batch from a stream as a part of a consumer group
   * @param stream the key of the stream from which to read
   * @param cursor the cursor from which to begin reading
   * @param groupId the key of the group to which the member belongs
   * @param groupMemberId the key of the member within the group
   * @param timeout the timeout in milliseconds to wait for a message
   */
  async readAsGroup(
    stream: string,
    cursor: string,
    groupId: string,
    groupMemberId: string,
    timeout: number
  ) {
    return (await this.client.xreadgroup(
      'GROUP',
      groupId,
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

  /**
   * Dispatch a blocking request for a stream message[s], and receive the messages as MappedStreamEvents
   * Returns a cursor & event list, which respectively identify the current stream position and the list of events
   * @param options {BlockingStreamBatchMapOptions}
   */
  async blockingStreamBatchMap(options: BlockingStreamBatchMapOptions) {
    const logger = this.logger;
    try {
      if (options.stream && typeof options.last === 'string') {
        let cursor = options.last || '$';
        const stream = shardDecorator({
          key: options.stream,
          shard: options.shard,
        });
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
              options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT,
              options.requestedBatchSize ?? DEFAULT_MAX_BATCH_SIZE
            )
        );

        for (const [_streamTitle, entries] of streamEvents ?? []) {
          for (const rawEvent of entries) {
            events.push(this.deserializeMessageArray(rawEvent, _streamTitle));
            cursor = rawEvent[0];
          }
        }

        return {
          cursor,
          events,
        };
      }

      if (!options.stream && typeof options.last === 'object') {
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

        const streamEvents = ((await this.client.xread(
          'BLOCK',
          options.blockingTimeout ?? HOURS_TO_MS(0.5),
          'STREAMS',
          ...streamsWithCursors,
        )) ?? []) as Array<[
          StreamId,
          Array<[_id: string, messaage: StreamResponseArray]>,
        ]>;

        for (const [_streamTitle, entries] of streamEvents ?? []) {
          for (const rawEvent of entries) {
            events.push(this.deserializeMessageArray(rawEvent, _streamTitle));
            cursor[_streamTitle] = rawEvent[0];
          }
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
        `Failed attempt to WOT call XREAD [key=${options.stream},shard=${options.shard}]`,
      );
    }
  }

  /**
   * @typedef {Object} StreamStreamOptions
   * @property {Topic} topic: the Topic from which to read
   * @property {string} [shard]: optionally, the shard from which to read
   * For a given Topic or stream, get a `Readable` stream which reads from the remote
   * @param options {StreamStreamOptions|GetReadStreamOptions}
   */
  getReadStream(options: { topic: Topic, shard?: string } | GetReadStreamOptions) {
    this.addStreamId('topic' in options ? options.topic.consumerKey(options.shard) : options.stream);
    return Readable.from(this.iterateStream(options), {
      objectMode: true,
    }) as Readable & { readableObjectMode: true };
  }

  /**
   * Get a `Writable` stream, for which written objects will be written to the remote
   * @param options {StreamStreamOptions}: The Topic to publish messages to
   */
  getWriteStream(options: { topic: Topic, shard?: string } | {
    stream: string;
    responseChannel?: string;
    shard?: string;
  }): Writable & { writableObjectMode: true } {
    return new Writable({
      objectMode: true,
      write: async (chunk: MappedStreamEvent, _, callback) => {
        if (!chunk.messageId || !chunk.payload) {
          this.logger.warn(
            `Dropping message with no messageId or payload: ${chunk}`,
          );
          return;
        }

        const incomingStreamName = 'topic' in options ? options.topic.consumerKey(options.shard) : options.stream;
        const outgoingStreamName = 'topic' in options ? options.topic.producerKey(options.shard) : options.responseChannel;

        const {messageId, payload} = chunk;
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

  /**
   * Get a key's value from the remote
   * @param key the key targeted
   * @param [shard]: optionally, the shard from which to read
   */
  async get(key: string, shard?: string) {
    try {
      return await this.client.get(shardDecorator({key, shard})) ?? undefined;
    } catch (err) {
      this.logger.error(err);
      throw new Error(`Failed attempt to call GET [key=${key},shard=${shard}]`);
    }
  }

  /**
   * Atomically increment a key's numeric value on the remote
   * @param key the key targeted
   * @param shard optionally, the shard from which to read
   */
  async incr(key: string, shard?: string) {
    try {
      return await this.client.incr(shardDecorator({key, shard})) ?? undefined;
    } catch (err) {
      this.logger.error(err);
      throw new Error(`Failed attempt to call INCR [key=${key},shard=${shard}]`);
    }
  }

  /**
   * Set a key's value on the remote
   * @param options {KeyOptions}: the key targeted
   * @param value the value to set
   */
  async set(options: KeyOptions, value: string) {
    try {
      if (!value) {
        throw new Error('Cannot SET to empty strings, use DELETE');
      }

      return (await this.client.set(shardDecorator(options), value)) === 'OK';
    } catch (err) {
      this.logger.error(err);
      throw new Error(
        `Failed attempt to call SET [key=${options.key}, shard=${options.shard}, value=${value}]`,
      );
    }
  }

  /**
   * Mark a remote stream message as Processed for a given Consumer Group
   * @param topic the Topic on which the message was published
   * @param groupId the Consumer Group ID
   * @param messageId the MessageID to mark as Processed
   * @param [shard]: optionally, the shard from which to read
   */
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

  /**
   * @typedef {Object} IterateStreamOptions
   * @property {string} stream: the stream key from which to read
   * @property {string} [shard]: optionally, the shard from which to read
   * @property {string} [last]: optionally, the last cursor retrieved
   * @property {number} [requestedBatchSize]: optionally, the number of messages to read
   * @property {number} [blockingTimeout]: optionally, the number of milliseconds to block
   * Get an AsyncIterable object, the values yielded from which will be a stream message
   * @param options
   * @private
   */
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
      hasNewStreams = true;
    };

    this.keyEvents.on(KeyEvents.UPDATE, refreshStreams);

    let active = true;
    this.keyEvents.once(KeyEvents.CANCEL, ()=>{
      active = false;
    });

    while(active) {
      if (hasNewStreams) {
        delete args.stream;
        hasNewStreams = false;
        if (typeof args.last === 'string' && options.stream) {
          args.last = {[options.stream]: args.last};
        }
      }

      const raced = (await Promise.race([
        this.blockingStreamBatchMap(args),
        new Promise(r => {
          this.keyEvents.once(KeyEvents.UPDATE, r);
        }),
      ])) as {
        cursor?: string | Record<string, string>;
        events: MappedStreamEvent[];
      };

      // Could be a timeout, or a key update, or cancelling all streams:
      if (!raced.cursor) {
        this.logger.info(
          'Change in streams detected, terminating pending connections',
        );
        await this.abort(false);
        continue;
      }

      // TODO: Set the last key in the remote store for recovery?
      args.last = raced.cursor;
      for (const event of raced.events) {
        yield event;
      }
    }
  }

  override async abort(e?: boolean) {
    await super.abort(e);
    this.keyEvents.emit(KeyEvents.CANCEL);
  }

}
