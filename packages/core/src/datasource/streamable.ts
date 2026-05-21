import { Readable, Writable } from 'stream';
import {
  type BlockingStreamBatchMapOptions,
  type KeyOptions,
  type MappedStreamEvent,
  MaybeConsumerGroupInstanceConfig,
  type MessageId,
  MessageType,
  type StreamableDataSource,
  type StreamId,
} from '../types';
import { Topic } from '../utils/topic';
import { RedisDataSource } from './base/remote';
import { EventEmitter } from 'events';
import { shardDecorator } from '../utils/keys';

enum KeyEvents {
  ADD_STREAM = 'addStream',
  REMOVE_STREAM = 'removeStream',
  UPDATE = 'update',
  CANCEL = 'abort',
}

const DEFAULT_BLOCKING_TIMEOUT = 100;
const DEFAULT_MAX_BATCH_SIZE = 10;

export type GetReadStreamOptions = {
  stream: string;
  shard?: string;
  last?: string;
  requestedBatchSize?: number;
  blockingTimeout?: number;
} & MaybeConsumerGroupInstanceConfig;

/**
 * A Redis-stream-backed data source over Bun's native `RedisClient`.
 *
 * The wire protocol is a fixed set of *named* stream fields written by
 * `writeToStream` and read back by `parseStreamReply`. Bun returns stream
 * replies as a RESP3 map — `{ [stream]: [ [id, [k, v, ...]] ] }` — and has no
 * typed Streams API, so all stream commands go through the raw `send()`.
 */
export class StreamingDataSource extends RedisDataSource
  implements StreamableDataSource {
  streamIdMap: Record<StreamId, number> = {};
  keyEvents: EventEmitter = new EventEmitter();
  responseType: MessageType = MessageType.RESPONSE;

  /**
   * Append a message to a stream (XADD). Field order is the streamerson wire
   * protocol. Native trimming is applied only when `options.maxLen` is set — an
   * opt-in backstop; the retention strategy is reverse-streamers draining to SQL.
   */
  public async writeToStream({ outgoingStream, incomingStream, messageType, messageId, message, sourceId, shard }: {
    outgoingStream: StreamId,
    incomingStream: StreamId | undefined,
    messageType: MessageType,
    messageId: MessageId,
    message: string,
    sourceId: string,
    shard?: string,
  }) {
    const key = shardDecorator({ key: outgoingStream, shard });
    const trim = this.options.maxLen && this.options.maxLen > 0
      ? ['MAXLEN', '~', String(this.options.maxLen)]
      : [];
    const fields = [
      'messageId', String(messageId),
      'messageType', String(messageType ?? this.responseType),
      'incomingStream', incomingStream ?? '',
      'messageHeaders', 'nil',
      'messageProtocol', 'json',
      'messageSourceId', sourceId ?? '',
      'payload', message,
    ];
    try {
      return await this.client.send('XADD', [key, ...trim, '*', ...fields]);
    } catch (err) {
      this.logger.error(err);
      throw new Error(
        `Failed XADD [key=${key}, response=${incomingStream}, shard=${shard}, err=${(err as Error).message}]`,
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

  /**
   * Decode a Bun stream reply into `MappedStreamEvent`s. Bun returns a RESP3
   * map keyed by stream name, each entry `[id, [field, value, field, value, ...]]`.
   * Fields are keyed by name (matching `writeToStream`). A null reply (BLOCK
   * timeout) yields `[]`.
   */
  private parseStreamReply(reply: unknown): MappedStreamEvent[] {
    if (!reply || typeof reply !== 'object') {
      return [];
    }
    const events: MappedStreamEvent[] = [];
    for (const [streamName, entries] of Object.entries(reply as Record<string, Array<[string, string[]]>>)) {
      for (const [id, kv] of entries ?? []) {
        const fields: Record<string, string> = {};
        for (let i = 0; i + 1 < kv.length; i += 2) {
          fields[kv[i]] = kv[i + 1];
        }

        const event: MappedStreamEvent = {
          streamId: streamName,
          streamMessageId: id,
          messageId: fields['messageId'],
          messageType: fields['messageType'] as MessageType,
          messageDestination: fields['incomingStream'],
          messageProtocol: fields['messageProtocol'] as MappedStreamEvent['messageProtocol'],
          messageSourceId: fields['messageSourceId'],
          payload: {},
        };

        if (fields['messageHeaders'] && fields['messageHeaders'] !== 'nil') {
          event.messageHeaders = JSON.parse(fields['messageHeaders']);
        }

        event.payload = fields['messageProtocol'] === 'json'
          ? JSON.parse(fields['payload'] ?? 'null')
          : fields['payload'];

        if (!event.messageId) {
          this.logger.error({ fields }, 'No Message ID in Message');
          throw new Error('No Message ID in Message');
        }

        events.push(event);
      }
    }
    return events;
  }

  /** Create a consumer group (idempotent: a pre-existing group is not an error). */
  async createConsumerGroup(config: { stream: string, groupId: string, cursor?: string }) {
    try {
      return await this.client.send('XGROUP', ['CREATE', config.stream, config.groupId, config.cursor ?? '$', 'MKSTREAM']);
    } catch (err) {
      if ((err as Error).message?.includes('BUSYGROUP')) {
        return 'OK';
      }
      throw err;
    }
  }

  async createGroupMember(config: { stream: string, groupId: string, groupMemberId: string, cursor?: string }) {
    return await this.client.send('XGROUP', ['CREATECONSUMER', config.stream, config.groupId, config.groupMemberId]);
  }

  /** Blocking XREAD as a lone consumer. */
  async readAsSingle(stream: string, cursor: string, timeout: number, batchSize = 1) {
    return await this.client.send('XREAD', [
      'COUNT', String(batchSize),
      'BLOCK', String(timeout),
      'STREAMS', stream, cursor,
    ]);
  }

  /** Blocking XREADGROUP (NOACK) as a member of a consumer group. */
  async readAsGroup(stream: string, cursor: string, groupId: string, groupMemberId: string, timeout: number) {
    return await this.client.send('XREADGROUP', [
      'GROUP', groupId, groupMemberId,
      'COUNT', String(DEFAULT_MAX_BATCH_SIZE),
      'BLOCK', String(timeout),
      'NOACK',
      'STREAMS', stream, cursor,
    ]);
  }

  /**
   * One blocking read cycle. Returns the advanced cursor and decoded events.
   * Single-stream mode (string `last`) reads as a group or lone consumer; the
   * multi-stream fan-in mode (object `last`) reads over `streamIdMap` via XREAD.
   */
  async blockingStreamBatchMap(options: BlockingStreamBatchMapOptions) {
    try {
      if (options.stream && typeof options.last === 'string') {
        let cursor = options.last || '$';
        const stream = shardDecorator({ key: options.stream, shard: options.shard });
        const timeout = options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT;
        const reply = await (options.consumerGroupInstanceConfig
          ? this.readAsGroup(
            stream,
            // Groups always take new (never-delivered) messages.
            // TODO: failure recovery needs the pending-entry id here instead.
            '>',
            options.consumerGroupInstanceConfig.groupId,
            options.consumerGroupInstanceConfig.groupMemberId,
            timeout,
          )
          : this.readAsSingle(stream, cursor, timeout, options.requestedBatchSize ?? DEFAULT_MAX_BATCH_SIZE));

        const events = this.parseStreamReply(reply);
        for (const event of events) {
          cursor = event.streamMessageId ?? cursor;
        }
        return { cursor, events };
      }

      if (!options.stream && typeof options.last === 'object') {
        const cursor = options.last;
        const streamKeys = Object.keys(this.streamIdMap);
        if (!streamKeys.length) {
          throw new Error('blockingStreamBatchMap: No streams to read from list of stream IDs');
        }

        const ids = streamKeys.map(s => cursor[s] ?? '$');
        const reply = await this.client.send('XREAD', [
          'BLOCK', String(options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT),
          'STREAMS', ...streamKeys, ...ids,
        ]);

        const events = this.parseStreamReply(reply);
        for (const event of events) {
          const name = event.streamId;
          if (name) {
            cursor[name] = event.streamMessageId ?? cursor[name];
          }
        }
        return { cursor, events };
      }

      throw new Error('Unrecognized control flow for blockingStreamBatchMap');
    } catch (err) {
      if (this.closing) {
        // Read interrupted by an intentional disconnect — not an error.
        return { cursor: options.last ?? '$', events: [] };
      }
      this.logger.error(err);
      throw new Error(`Failed XREAD [key=${options.stream}, shard=${options.shard}]`);
    }
  }

  getReadStream(options: { topic: Topic, shard?: string } | GetReadStreamOptions) {
    this.addStreamId('topic' in options ? options.topic.consumerKey(options.shard) : options.stream);
    return Readable.from(
      this.iterateStream('topic' in options ? { ...options, stream: options.topic.consumerKey() } : options),
      { objectMode: true },
    ) as Readable & { readableObjectMode: true };
  }

  getWriteStream(options: { topic: Topic, shard?: string } | {
    stream: string;
    responseChannel?: string;
    shard?: string;
  }): Writable & { writableObjectMode: true } {
    return new Writable({
      objectMode: true,
      write: async (_chunk: MappedStreamEvent, _, callback) => {
        const chunk: MappedStreamEvent = JSON.parse(JSON.stringify(_chunk));
        if (!chunk.messageId || !chunk.payload) {
          this.logger.warn(`Dropping message with no messageId or payload: ${JSON.stringify(chunk)}`);
          return callback();
        }

        const incomingStreamName = 'topic' in options ? options.topic.consumerKey(options.shard) : options.stream;
        const outgoingStreamName = 'topic' in options ? options.topic.producerKey(options.shard) : options.responseChannel;

        await this.writeToStream({
          outgoingStream: incomingStreamName,
          incomingStream: outgoingStreamName,
          messageType: chunk.messageType as MessageType,
          messageId: chunk.messageId,
          message: JSON.stringify(chunk.payload),
          sourceId: chunk.messageSourceId ?? '',
          shard: options.shard,
        });
        callback();
      },
    }) as Writable & { writableObjectMode: true };
  }

  async get(key: string, shard?: string) {
    try {
      return (await this.client.send('GET', [shardDecorator({ key, shard })])) ?? undefined;
    } catch (err) {
      this.logger.error(err);
      throw new Error(`Failed GET [key=${key}, shard=${shard}]`);
    }
  }

  async incr(key: string, shard?: string) {
    try {
      return await this.client.send('INCR', [shardDecorator({ key, shard })]);
    } catch (err) {
      this.logger.error(err);
      throw new Error(`Failed INCR [key=${key}, shard=${shard}]`);
    }
  }

  async set(options: KeyOptions, value: string) {
    try {
      if (!value) {
        throw new Error('Cannot SET to empty strings, use DELETE');
      }
      return (await this.client.send('SET', [shardDecorator(options), value])) === 'OK';
    } catch (err) {
      this.logger.error(err);
      throw new Error(`Failed SET [key=${options.key}, shard=${options.shard}, value=${value}]`);
    }
  }

  /**
   * XACK a message for a consumer group. Uses the control connection when
   * available so the ack doesn't queue behind a blocking read on the data
   * connection. (A no-op against NOACK reads — see PROJECT.md Gap C.)
   */
  async markProcessedByGroup(topic: Topic, groupId: string, messageId: string, shard?: string) {
    const conn = this.options.controllable && this._control ? this.control : this.client;
    return await conn.send('XACK', [topic.consumerKey(shard), groupId, messageId]);
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

    const refreshStreams = () => { hasNewStreams = true; };
    this.keyEvents.on(KeyEvents.UPDATE, refreshStreams);

    let active = true;
    this.keyEvents.once(KeyEvents.CANCEL, () => { active = false; });

    while (active) {
      if (hasNewStreams) {
        delete args.stream;
        hasNewStreams = false;
        if (typeof args.last === 'string' && options.stream) {
          args.last = { [options.stream]: args.last };
        }
      }

      const raced = (await Promise.race([
        this.blockingStreamBatchMap(args),
        new Promise(r => { this.keyEvents.once(KeyEvents.UPDATE, r); }),
      ])) as {
        cursor?: string | Record<string, string>;
        events: MappedStreamEvent[];
      };

      // A key update / cancel resolves the race with no cursor:
      if (!raced.cursor) {
        this.logger.info('Change in streams detected, terminating pending connections');
        await this.abort(false);
        continue;
      }

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
