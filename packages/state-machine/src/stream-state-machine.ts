import { Transform } from 'stream';
import { EventEmitter } from 'events';
import Pino, { Logger } from 'pino';
import { ApplicationState, StateConfiguration, StateTransformer, StateTransformerMap } from './types';
import { StateCache } from './state-cache';
import {
  buildStreamConfiguration, ChannelTupleArray, ids, IncomingChannel,
  KeyOptions, MappedStreamEvent, NonNullablePrimitive, NullablePrimitive, OutgoingChannel,
  shardDecorator,
  streamAwaiter, StreamersonLogger,
  StreamingDataSource, StreamMeta, Topic
} from '@streamerson/core';
// The runtime MessageType enum is not re-exported from core's index (known export
// gap); the subpath import is required for the real wire values (audit 2.8).
import { MessageType } from '@streamerson/core/src/types';
import { StreamConsumer, StreamConsumerOptions } from '@streamerson/consumer';

type UserRecord = {
  id: string
}

type EventHandler<AState, T = any> = (state: StateTransformerMap<AState>, event: MappedStreamEvent<any, T>, metadata: Record<string, any>) => Promise<string | Record<string, any> | null | undefined | void>

export class StreamStateMachine<
  AState extends Record<string, NullablePrimitive | { [key: string]: any }>
> extends StreamConsumer<any> {
  stateCache: StateCache<AState>;
  transferChannel: ReturnType<typeof streamAwaiter>;
  /** Stable machine identity for ownership claims + transfer source attribution (D14). */
  readonly machineId = ids.guuid();
  /** D14 registry claims held by this machine; released (DEL) on clean disconnect. */
  readonly ownershipClaims: string[] = [];
  private transferWriteChannel: StreamingDataSource;
  private transferReadChannel: StreamingDataSource;
  private transferChannelConnected = false;
  // `declare`, not a field: Bun emits declaration-only class fields with define
  // semantics, which would wipe the base's `streamEvents = {}` to undefined after
  // super() — erasing eventMap registrations and making registerStreamEvent throw.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //@ts-ignore
  declare streamEvents: Record<string, EventHandler<AState>>;
  public stateTransformers: StateTransformerMap<AState>;

  constructor(public override options: StreamConsumerOptions<any> & { stateConfigurations: any }) {
    super(options);
    this.stateCache = new StateCache({
      ...options,
      logger: this.logger as any
    });
    this.transferReadChannel = new StreamingDataSource(options.redisConfiguration ? {
      ...options.redisConfiguration,
      logger: this.logger
    } : undefined);
    this.transferWriteChannel = new StreamingDataSource(options.redisConfiguration ? {
      ...options.redisConfiguration,
      logger: this.logger
    } : undefined);
    this.transferChannel = streamAwaiter({
      readChannel: this.transferReadChannel,
      writeChannel: this.transferWriteChannel,
      incomingStream: `${shardDecorator({
        key: this.topic.consumerKey(),
        shard: options.shard
      })}::incoming_state_transfer`
    });
    this.stateTransformers = Object.keys(options.stateConfigurations).reduce((mappedTransformers, stateKey: keyof AState) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore because apparently typescript don't work too good
      mappedTransformers[stateKey] = this.getStateTransformers(stateKey);
      return mappedTransformers;
    }, { getClient: () => this.stateCache.autoCache.client } as unknown as StateTransformerMap<AState>);
  }

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
      get: async (propertyTarget: string, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return await this.stateCache.get(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
      },
      set: async (propertyTarget: string, value: string | number | null, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return await this.stateCache.set(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), value);
      },
      getHash: async (propertyTarget: string, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return this.stateCache.getHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
      },
      setHash: async (propertyTarget: string, valueOrPropertyTarget: string | Record<string, any>, value?: Record<string, any>, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return this.stateCache.setHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), valueOrPropertyTarget, value);
      },
      transfer: async (propertyTarget: string, shardTarget: string, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        const keyOptions = this.cacheComposite(cacheKey ?? propertyTarget);
        // Precondition (audit 2.12): read through the state layer, which derives the
        // SAME physical key the write paths use (cacheComposite + shardDecorator) and,
        // for owners, lazily hydrates from Redis (D-Hydration) — so durable-but-evicted
        // owned state transfers too.
        const stateData = await this.stateCache.get(stateTarget, keyOptions);
        if (stateData === null || stateData === undefined) {
          throw new Error(`Cannot transfer state '${String(stateTarget)}.${propertyTarget}': no state held at derived key '${shardDecorator(keyOptions)}'`);
        }
        // The wire target is the TARGET shard's transfer stream (the dispatcher's own
        // `transferChannel.incomingStream` is the mirror it will itself receive on).
        const targetStream = `${shardDecorator({ key: this.topic.consumerKey(), shard: shardTarget })}::incoming_state_transfer`;
        if (!this.transferChannelConnected) {
          await this.transferWriteChannel.connect();
          this.transferChannelConnected = true;
        }
        // Interim dispatch-and-return (D-Transfer): the receive side (durable ack +
        // rollback) does not exist yet, so awaiting the transferChannel deferral could
        // only ever time out. The XADD below is awaited — the entry is durably placed —
        // and the caller gets `true` on placement. When the ack protocol lands, this
        // becomes a dispatch through `transferChannel` with local-delete-on-ack.
        await this.transferWriteChannel.writeToStream({
          outgoingStream: targetStream,
          incomingStream: `${shardDecorator({ key: this.topic.consumerKey(), shard: this.options.shard })}::incoming_state_transfer`,
          messageType: MessageType.TRANSFER,
          messageId: ids.guuid(),
          message: JSON.stringify({ stateType: stateTarget, stateData }),
          sourceId: this.machineId
        });
        return true;
      },
      broadcast: async (toStream, payload, sourceId) => {
        await this.outgoingChannel?.writeToStream({
          outgoingStream: toStream,
          incomingStream: undefined,
          messageType: MessageType.BROADCAST,
          messageId: ids.guuid(),
          message: JSON.stringify(payload),
          sourceId: sourceId
        });
      }
    };
  }

  async atomicallyIncrementState(stateTarget: keyof AState, keyOptions: KeyOptions) {
    return await this.stateCache.incr(stateTarget, keyOptions);
  }

  async atomicallyDecrementState(stateTarget: keyof AState, keyOptions: KeyOptions) {
    return await this.stateCache.decr(stateTarget, keyOptions);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  override async registerStreamEvent<
    T extends Record<string, any>,
    R extends (Record<string, NullablePrimitive> | void) = Record<string, NonNullablePrimitive>
  >(
    eventKey: keyof typeof this.streamEvents,
    handler: (state: StateTransformerMap<AState>, message: T, meta: {
      sourceId: string
    }) => Promise<R>
  ): Promise<void> {
    super.registerStreamEvent(eventKey, (async (state: StateTransformerMap<any>, _args: any, meta: any) => {
      let args = _args
      if(typeof args === 'string') {
        args = JSON.parse(_args)
        if(typeof args === 'string') {
          args = JSON.parse(args)
        }
      }
      const output = await handler(state, args, meta)
      return output
    }) as any);
  }

  override get _handle_message() {
    return (async (streamMessage: MappedStreamEvent): Promise<MappedStreamEvent<any, any, any>> => {
      const handler = this.streamEvents[streamMessage.messageType];
      const response = await handler(
        this.stateTransformers,
        streamMessage.payload as any,
        {
          sourceId: streamMessage.messageSourceId
        }
        // typeof streamMessage.payload === 'object' ?
        //   streamMessage.payload :
        //   JSON.parse(streamMessage.payload as unknown as string | undefined ?? 'null')
      );
      return {
        ...streamMessage,
        messageType: 'resp' as MessageType,
        payload: response
      };
    });
  }

  /**
   * D14 ownership claim: for every owner-configured state key, assert
   * `SET owner:<topic>:<derived-key> <machineId> NX` at connect; a second claimant
   * over the same keys fails loudly, naming the contested key and its holder.
   *
   * Claim keys are scoped by the machine's topic (its stream identity) so unrelated
   * machines with a same-named state key never contest each other's registry entry.
   *
   * Liveness strategy (minimal honest form): plain NX with DEL on clean disconnect.
   * Tradeoff: a crashed owner leaves a stale claim that must be released out-of-band;
   * a TTL lease refreshed on activity is the follow-up once a heartbeat exists.
   */
  private async claimOwnership(): Promise<void> {
    const client = this.stateCache.autoCache.client;
    const stateConfigurations = this.options.stateConfigurations as Record<string, StateConfiguration>;
    for (const [stateKey, conf] of Object.entries(stateConfigurations)) {
      if (!conf.owner) continue;
      const derived = conf.dataKey ? conf.dataKey(stateKey, {}) : stateKey;
      const claimKey = `owner:${this.topic.consumerKey()}:${shardDecorator(this.cacheComposite(derived))}`;
      const reply = await client.set(claimKey, this.machineId, { NX: true });
      if (reply !== 'OK') {
        const holder = await client.get(claimKey);
        throw new Error(
          `Ownership claim rejected for state '${stateKey}': registry key '${claimKey}' is already held by machine '${holder ?? 'unknown'}' (this machine: '${this.machineId}')`
        );
      }
      this.ownershipClaims.push(claimKey);
    }
  }

  override async disconnect() {
    // Release D14 claims first, while the registry client is still open.
    if (this.ownershipClaims.length) {
      try {
        await this.stateCache.autoCache.client.del(this.ownershipClaims);
      } catch (err) {
        this.logger.error(err, 'Failed to release ownership claims on disconnect');
      }
      this.ownershipClaims.length = 0;
    }
    await Promise.all([
      super.disconnect(),
      this.stateCache.disconnect(),
      // The transfer write channel connects lazily on first transfer (audit 2.4/2.13);
      // close it iff it opened. The read channel stays cold until the D-Transfer
      // receive side exists.
      this.transferChannelConnected ? this.transferWriteChannel.disconnect() : Promise.resolve()
    ]);
    this.transferChannelConnected = false;
  }

  override async connectAndListen() {
    await Promise.all([
      super.connectAndListen(),
      (async () => {
        await this.stateCache.connect();
        await this.claimOwnership(); // D14: fail loudly BEFORE this machine serves as owner
      })()
    ]);
  }
}
