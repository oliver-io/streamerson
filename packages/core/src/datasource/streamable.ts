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

/**
 * Atomic terminal transitions for reliable consumer-group delivery
 * (REQUEST_STREAM_RECEIPT.md §8). Each runs `{write; XACK}` as one Lua call so the
 * record (response or dead-letter) is durable iff the request leaves the PEL —
 * closing the internal ack-gap (CG-I6). Field order is irrelevant: the wire format
 * is keyed by name, matching `writeToStream`/`parseStreamReply`.
 */
const RESPOND_AND_ACK_LUA = `-- KEYS[1]=producer stream  KEYS[2]=consumer stream
-- ARGV: 1=groupId 2=streamMessageId 3=messageId 4=messageType 5=messageSourceId 6=payload(json)
redis.call('XADD', KEYS[1], '*',
  'messageId', ARGV[3], 'messageType', ARGV[4], 'incomingStream', '',
  'messageHeaders', 'nil', 'messageProtocol', 'json',
  'messageSourceId', ARGV[5], 'payload', ARGV[6])
redis.call('XACK', KEYS[2], ARGV[1], ARGV[2])
return 1`;

const DEADLETTER_AND_ACK_LUA = `-- KEYS[1]=dead-letter stream  KEYS[2]=consumer stream
-- ARGV: 1=groupId 2=streamMessageId 3=messageId 4=reason 5=consumer 6=deliveryCount 7=payload 8=failedAt
redis.call('XADD', KEYS[1], '*',
  'messageId', ARGV[3], 'reason', ARGV[4], 'consumer', ARGV[5],
  'deliveryCount', ARGV[6], 'payload', ARGV[7], 'failedAt', ARGV[8])
redis.call('XACK', KEYS[2], ARGV[1], ARGV[2])
return 1`;

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
  /** SHAs of the atomic terminal-transition scripts, populated by `connect()`. */
  private _scriptShas: { respondAndAck?: string; deadLetterAndAck?: string } = {};

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
    // State before signal: a live read loop picks up the new set from `streamIdMap`
    // at its next cycle, so the map must be current before UPDATE is observed.
    this.streamIdMap[streamId] = Date.now();
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
  }

  hasStreamId(streamId: StreamId) {
    return Boolean(this.streamIdMap[streamId]);
  }

  removeStreamId(streamId: StreamId) {
    delete this.streamIdMap[streamId];
    this.keyEvents.emit(KeyEvents.UPDATE, streamId);
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
        try {
          const fields: Record<string, string> = {};
          for (let i = 0; i + 1 < kv.length; i += 2) {
            fields[kv[i]] = kv[i + 1];
          }

          // Tolerate foreign/malformed entries (F3): an entry with no messageId was not
          // written by streamerson — skip + log rather than throwing, which would end
          // the whole reader and lose every entry after it. The cursor still advances
          // past it (see blockingStreamBatchMap), so a trailing bad entry can't wedge
          // the loop.
          if (!fields['messageId']) {
            this.logger.warn({ streamName, streamMessageId: id }, 'Skipping stream entry with no messageId');
            continue;
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

          events.push(event);
        } catch (err) {
          // A decode failure on one entry (e.g. malformed JSON payload/headers) must
          // not sink the batch or the reader — skip + log, keep the good entries (F3).
          this.logger.warn({ streamName, streamMessageId: id, err: (err as Error).message }, 'Skipping undecodable stream entry');
          continue;
        }
      }
    }
    return events;
  }

  /**
   * Highest entry id per stream in a raw reply (entries are id-ordered, so the last is
   * the max). Used to advance the read cursor past ALL returned entries — including any
   * that `parseStreamReply` skipped — so a trailing undecodable entry isn't re-read every
   * cycle (F3).
   */
  private lastIdsByStream(reply: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!reply || typeof reply !== 'object') return out;
    for (const [streamName, entries] of Object.entries(reply as Record<string, Array<[string, string[]]>>)) {
      const list = entries ?? [];
      if (list.length) out[streamName] = String(list[list.length - 1][0]);
    }
    return out;
  }

  /**
   * Create a consumer group. Idempotent on a pre-existing group: that case returns
   * the `'BUSYGROUP'` sentinel rather than throwing, so a caller can distinguish
   * created-vs-already-existed. Any other failure (e.g. WRONGTYPE) propagates —
   * group-create errors must be surfaced, not swallowed (CG-A5).
   */
  async createConsumerGroup(config: { stream: string, groupId: string, cursor?: string }) {
    try {
      return await this.client.send('XGROUP', ['CREATE', config.stream, config.groupId, config.cursor ?? '$', 'MKSTREAM']);
    } catch (err) {
      if ((err as Error).message?.includes('BUSYGROUP')) {
        return 'BUSYGROUP';
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

  /**
   * Blocking XREADGROUP as a member of a consumer group. Delivered entries enter
   * the consumer's PEL (no `NOACK`), so an unacked entry survives a crash as a
   * recoverable pending entry — the basis of the no-silent-loss contract
   * (docs/specs/REQUEST_STREAM_RECEIPT.md). The caller XACKs only on success.
   */
  async readAsGroup(stream: string, cursor: string, groupId: string, groupMemberId: string, timeout: number, count = DEFAULT_MAX_BATCH_SIZE) {
    return await this.client.send('XREADGROUP', [
      'GROUP', groupId, groupMemberId,
      'COUNT', String(count),
      'BLOCK', String(timeout),
      'STREAMS', stream, cursor,
    ]);
  }

  /**
   * The stream's current top entry id (last-generated), or `'0'` when empty/absent.
   * Used to seed a stable only-new cursor for a newly-added fan-in stream so a busy
   * sibling can't starve it by re-resolving `'$'` each cycle. `XREVRANGE` on a missing
   * key returns empty (no throw), so an absent stream seeds at `'0'` (read from start).
   */
  private async lastGeneratedId(key: string): Promise<string> {
    try {
      const reply = await this.client.send('XREVRANGE', [key, '+', '-', 'COUNT', '1']) as Array<[string, string[]]> | null;
      return reply && reply.length ? String(reply[0][0]) : '0';
    } catch {
      return '0';
    }
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
            // Groups take new (never-delivered) messages; self-PEL recovery ('0')
            // is opt-in retry (REQUEST_STREAM_RECEIPT.md §7), not wired here yet.
            '>',
            options.consumerGroupInstanceConfig.groupId,
            options.consumerGroupInstanceConfig.groupMemberId,
            timeout,
            options.requestedBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
          )
          : this.readAsSingle(stream, cursor, timeout, options.requestedBatchSize ?? DEFAULT_MAX_BATCH_SIZE));

        const events = this.parseStreamReply(reply);
        // Advance past ALL returned entries (incl. any skipped/undecodable ones) so a
        // trailing foreign entry isn't re-read forever (F3). For group reads the cursor
        // is moot ('>' is always used), so this is harmless there.
        const lastIds = this.lastIdsByStream(reply);
        return { cursor: lastIds[stream] ?? cursor, events };
      }

      if (!options.stream && typeof options.last === 'object') {
        const cursor = options.last;
        const streamKeys = Object.keys(this.streamIdMap);
        if (!streamKeys.length) {
          throw new Error('blockingStreamBatchMap: No streams to read from list of stream IDs');
        }

        // Seed a STABLE explicit cursor for any newly-added stream the first time it is
        // read. A re-resolving '$' would let a busy sibling starve a quiet new stream —
        // '$' advances to the live tip every cycle, skipping the new stream's entries
        // before they are ever read. Capturing the tip once as an explicit id gives the
        // same only-new semantics, but stable. (STREAM_READER_DEFECTS.md F1)
        for (const s of streamKeys) {
          if (cursor[s] === undefined) {
            cursor[s] = await this.lastGeneratedId(s);
          }
        }

        const ids = streamKeys.map(s => cursor[s]);
        const reply = await this.client.send('XREAD', [
          'BLOCK', String(options.blockingTimeout ?? DEFAULT_BLOCKING_TIMEOUT),
          'STREAMS', ...streamKeys, ...ids,
        ]);

        const events = this.parseStreamReply(reply);
        // Advance each stream's cursor past all its returned entries (incl. skipped
        // ones), so a trailing undecodable entry on any stream can't wedge the loop (F3).
        const lastIds = this.lastIdsByStream(reply);
        for (const [name, id] of Object.entries(lastIds)) {
          cursor[name] = id;
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

  /**
   * Open a Redis stream as an objectMode `Readable` of decoded `MappedStreamEvent`s.
   * Consume it as an async-iterable, via `.on('data')`, or with `.pipe()`.
   *
   * Cursor semantics (`last`, single-stream mode) — choose deliberately (F5):
   *   - `'$'` (default): only entries newer than the subscription. The tip is resolved
   *     at the FIRST read, not at this call — there is no atomic subscribe, so a reader
   *     joining a non-empty/active stream silently skips whatever is already present or
   *     arrives in the join window. Correct for "tail from now"; lossy for "drain a
   *     backlog" — use `'0'` for that.
   *   - `'0'`: from the start (full history) — loss-free.
   *   - `<id>`: strictly after that entry id.
   *
   * Consumer-group mode (`consumerGroupInstanceConfig`) is an INTERNAL building block
   * for the `@streamerson/consumer` package (F6): it reads only NEW (`'>'`) messages,
   * does NOT resume a member's pending (delivered-unacked) entries, and exposes no ack.
   * PEL resume (`'0'` drain) and acking are owned by `ConsumerGroupMember`
   * (`readGroupEntries`/`markProcessedByGroup`); note also that objectMode read-ahead
   * pulls entries into the PEL ahead of consumption. Do not use this path as a
   * standalone group consumer.
   */
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
      // Write failures are surfaced via `callback(err)` → an `'error'` event, never
      // swallowed (F2). A chunk is dropped only when it has no `messageId` or a
      // null/undefined `payload`; falsy-but-valid payloads (`0`, `''`, `false`) are
      // kept (F4). The chunk is used directly — the previous per-message
      // `JSON.parse(JSON.stringify(chunk))` deep-clone was an unneeded cost that also
      // broke non-JSON payloads (F7). The write path is JSON-only: `payload` is
      // JSON-serialized and `messageProtocol` is always 'json'.
      write: (chunk: MappedStreamEvent, _enc, callback) => {
        try {
          if (!chunk.messageId || chunk.payload == null) {
            this.logger.warn(`Dropping message with no messageId or payload: ${JSON.stringify(chunk)}`);
            return callback();
          }

          const incomingStreamName = 'topic' in options ? options.topic.consumerKey(options.shard) : options.stream;
          const outgoingStreamName = 'topic' in options ? options.topic.producerKey(options.shard) : options.responseChannel;

          // JSON.stringify here can throw synchronously on a non-serializable payload
          // (e.g. bigint) — caught below and surfaced as an error, not a silent stall.
          this.writeToStream({
            outgoingStream: incomingStreamName,
            incomingStream: outgoingStreamName,
            messageType: chunk.messageType as MessageType,
            messageId: chunk.messageId,
            message: JSON.stringify(chunk.payload),
            sourceId: chunk.messageSourceId ?? '',
            shard: options.shard,
          }).then(() => callback()).catch((err) => callback(err as Error));
        } catch (err) {
          callback(err as Error);
        }
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
   * connection. Plain XACK — the success path for non-bidirectional handlers
   * (bidirectional success uses the atomic {@link respondAndAck}).
   */
  async markProcessedByGroup(topic: Topic, groupId: string, messageId: string, shard?: string) {
    const conn = this.control_or_client();
    return await conn.send('XACK', [topic.consumerKey(shard), groupId, messageId]);
  }

  /** The control connection when controllable, else the data connection. */
  private control_or_client() {
    return this.options.controllable && this._control ? this.control : this.client;
  }

  /** Cache the atomic terminal-transition scripts in the server's script cache. */
  private async loadScripts() {
    try {
      this._scriptShas.respondAndAck = String(await this.client.send('SCRIPT', ['LOAD', RESPOND_AND_ACK_LUA]));
      this._scriptShas.deadLetterAndAck = String(await this.client.send('SCRIPT', ['LOAD', DEADLETTER_AND_ACK_LUA]));
    } catch (err) {
      // Non-fatal: a missing SHA at call time is covered by the EVAL fallback.
      this.logger.warn(err, 'SCRIPT LOAD failed; terminal transitions will fall back to EVAL');
    }
  }

  /** EVALSHA with a transparent EVAL fallback on NOSCRIPT (cache miss / SCRIPT FLUSH). */
  private async evalScript(sha: string | undefined, src: string, numKeys: number, keysAndArgs: string[]) {
    const conn = this.control_or_client();
    if (sha) {
      try {
        return await conn.send('EVALSHA', [sha, String(numKeys), ...keysAndArgs]);
      } catch (err) {
        if (!String((err as Error).message).includes('NOSCRIPT')) throw err;
      }
    }
    return await conn.send('EVAL', [src, String(numKeys), ...keysAndArgs]);
  }

  /**
   * Bidirectional terminal success: atomically write the response to the producer
   * stream and XACK the request (CG-I6 — the response is durable iff the request
   * leaves the PEL). Runs on the control connection.
   */
  async respondAndAck(args: {
    producerStream: string; consumerStream: string; groupId: string;
    streamMessageId: string; messageId: string; messageType: string;
    messageSourceId: string; payload: string;
  }) {
    return this.evalScript(this._scriptShas.respondAndAck, RESPOND_AND_ACK_LUA, 2, [
      args.producerStream, args.consumerStream,
      args.groupId, args.streamMessageId, args.messageId, args.messageType, args.messageSourceId, args.payload,
    ]);
  }

  /**
   * Terminal failure: atomically record a dead-letter entry (cause + provenance)
   * and XACK the request. Used both inline (a handler-surfaced failure) and by the
   * reaper (an abandoned entry). Runs on the control connection.
   */
  async deadLetterAndAck(args: {
    deadLetterStream: string; consumerStream: string; groupId: string;
    streamMessageId: string; messageId: string; reason: string; consumer: string;
    deliveryCount: string; payload: string; failedAt: string;
  }) {
    return this.evalScript(this._scriptShas.deadLetterAndAck, DEADLETTER_AND_ACK_LUA, 2, [
      args.deadLetterStream, args.consumerStream,
      args.groupId, args.streamMessageId, args.messageId, args.reason, args.consumer,
      args.deliveryCount, args.payload, args.failedAt,
    ]);
  }

  /**
   * Reclaim entries idle ≥ `minIdle` ms into `consumer` (XAUTOCLAIM), atomically
   * resetting their idle time so a concurrent reclaimer's idle filter excludes
   * them. Returns the next scan cursor (`'0-0'` when the scan wraps) and the
   * claimed entries decoded as `MappedStreamEvent`s.
   */
  async claimStale(stream: string, groupId: string, consumer: string, minIdle: number, cursor = '0-0', count = 100) {
    const conn = this.control_or_client();
    const reply = await conn.send('XAUTOCLAIM', [stream, groupId, consumer, String(minIdle), cursor, 'COUNT', String(count)]) as unknown[];
    const nextCursor = String(reply?.[0] ?? '0-0');
    const claimed = (reply?.[1] ?? []) as Array<[string, string[]]>;
    return { cursor: nextCursor, entries: this.parseStreamReply({ [stream]: claimed }) };
  }

  /**
   * Read entries from a consumer group at an explicit cursor and decode them. With
   * cursor `'0'` this returns the consumer's own already-delivered, unacked entries
   * (its PEL) for self-recovery; with `'>'` it returns new messages. `'0'` reads
   * never block and bump each returned entry's delivery count.
   */
  async readGroupEntries(stream: string, groupId: string, consumer: string, cursor: string, timeout: number, count = DEFAULT_MAX_BATCH_SIZE) {
    return this.parseStreamReply(await this.readAsGroup(stream, cursor, groupId, consumer, timeout, count));
  }

  /**
   * XPENDING (extended form) → per-entry delivery details. When `consumer` is given,
   * only that consumer's pending entries are returned. `deliveryCount` is how many
   * times Redis has delivered the entry (bumped by every read/reclaim) — the basis
   * for the retry attempt cap.
   */
  async pendingDetails(stream: string, groupId: string, count = 100, consumer?: string) {
    const conn = this.control_or_client();
    const args = [stream, groupId, '-', '+', String(count)];
    if (consumer) args.push(consumer);
    const reply = await conn.send('XPENDING', args) as Array<[string, string, number | string, number | string]>;
    return (reply ?? []).map(([id, holder, idle, deliveryCount]) => ({
      id: String(id),
      consumer: String(holder),
      idle: Number(idle),
      deliveryCount: Number(deliveryCount),
    }));
  }

  override async connect() {
    await super.connect();
    await this.loadScripts();
    return this;
  }

  /**
   * Current top entry id of a stream (last-generated), or `'0'` if empty/absent/unreachable.
   * Seeds a loss-free "from now" reader cursor without the `'$'` arm-up gap (GW15): a reader
   * that opens at this captured id catches everything written after it, including the arm-up
   * window and (on a self-heal re-arm) the whole outage backlog. Tolerant — a not-yet-connected
   * client yields `'0'` (see {@link lastGeneratedId}), so callers may seed eagerly.
   */
  async currentTopId(key: string, shard?: string): Promise<string> {
    return this.lastGeneratedId(shardDecorator({ key, shard }));
  }

  /**
   * The read loop. Yields decoded events from the current stream set until cancelled.
   *
   * Dynamic stream-set semantics (STREAM_READER_DEFECTS.md F1): a runtime stream-set
   * change (`addStreamId`/`removeStreamId`, observed as a `keyEvents` UPDATE) is
   * **passive** — it sets `hasNewStreams` but does NOT interrupt the in-flight read.
   * The current blocking read on the unchanged set runs to completion (returning on
   * data, or on its BLOCK timeout) and the new set is folded in at the next loop top.
   * So already-registered streams are never interrupted, and a newly-added stream is
   * picked up within at most one `blockingTimeout`. Once in multi-stream mode,
   * `blockingStreamBatchMap` re-reads `streamIdMap` every cycle, so further add/remove
   * need no signalling.
   *
   * `wake()` is reserved for CANCEL (teardown): it lets the loop stop awaiting a parked
   * read and exit promptly on `disconnect()`/`abort()` instead of waiting out the BLOCK.
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

    let active = true;

    // One re-armable "wake" promise lets a CANCEL interrupt a parked blocking read so
    // teardown is prompt; a stream-set change (UPDATE) is intentionally passive and does
    // NOT wake the read (see method doc). One persistent listener each avoids the
    // per-cycle listener leak of the old `once()`-per-iteration approach (CG-I1).
    let wake!: () => void;
    let wakePromise!: Promise<void>;
    const armWake = () => { wakePromise = new Promise<void>(r => { wake = r; }); };
    const onUpdate = () => { hasNewStreams = true; };
    const onCancel = () => { active = false; wake(); };
    this.keyEvents.on(KeyEvents.UPDATE, onUpdate);
    this.keyEvents.on(KeyEvents.CANCEL, onCancel);

    try {
      while (active) {
        if (hasNewStreams) {
          hasNewStreams = false;
          // Transition single-stream → multi-stream fan-in, carrying the original
          // stream's cursor so it resumes exactly where it left off (no gap/re-read).
          if (args.stream) {
            if (typeof args.last === 'string') {
              args.last = { [args.stream]: args.last };
            }
            delete args.stream;
          }
        }

        armWake();
        const raced = (await Promise.race([
          this.blockingStreamBatchMap(args),
          wakePromise,
        ])) as {
          cursor?: string | Record<string, string>;
          events: MappedStreamEvent[];
        } | undefined;

        // Only a CANCEL resolves the race with no result (UPDATE is passive) — teardown.
        if (!raced) {
          break;
        }

        args.last = raced.cursor ?? args.last;
        for (const event of raced.events) {
          yield event;
        }
      }
    } finally {
      this.keyEvents.removeListener(KeyEvents.UPDATE, onUpdate);
      this.keyEvents.removeListener(KeyEvents.CANCEL, onCancel);
    }
  }

  override async abort(e?: boolean) {
    await super.abort(e);
    this.keyEvents.emit(KeyEvents.CANCEL);
  }
}
