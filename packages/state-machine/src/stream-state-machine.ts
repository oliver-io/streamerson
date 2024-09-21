import { Transform } from 'stream';
import { EventEmitter } from 'events';
import Pino, { Logger } from 'pino';
import { ApplicationState, StateConfiguration, StateTransformer, StateTransformerMap } from './types';
import { StateCache } from './state-cache';
import {
  buildStreamConfiguration, ChannelTupleArray, ids, IncomingChannel,
  KeyOptions, MappedStreamEvent, MessageType, NonNullablePrimitive, NullablePrimitive, OutgoingChannel,
  shardDecorator,
  streamAwaiter, StreamersonLogger,
  StreamingDataSource, StreamMeta, Topic
} from '@streamerson/core';
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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //@ts-ignore
  override streamEvents: Record<string, EventHandler<AState>>;
  public stateTransformers: StateTransformerMap<AState>;

  constructor(public override options: StreamConsumerOptions<any> & { stateConfigurations: any }) {
    super(options);
    this.stateCache = new StateCache({
      ...options,
      logger: this.logger as any
    });
    this.transferChannel = streamAwaiter({
      readChannel: new StreamingDataSource(options.redisConfiguration ? {
        ...options.redisConfiguration,
        logger: this.logger
      } : undefined),
      writeChannel: new StreamingDataSource(options.redisConfiguration ? {
        ...options.redisConfiguration,
        logger: this.logger
      } : undefined),
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
      }, useShard = true) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return await this.stateCache.get(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
      },
      set: async (propertyTarget: string, value: string | number | null, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }, useShard = true) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return await this.stateCache.set(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), value);
      },
      getHash: async (propertyTarget: string, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }, useShard = true) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return this.stateCache.getHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget));
      },
      setHash: async (propertyTarget: string, valueOrPropertyTarget: string | Record<string, any>, value?: Record<string, any>, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }, useShard = true) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        return this.stateCache.setHash(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget), valueOrPropertyTarget, value);
      },
      transfer: async (propertyTarget: string, shardTarget: string, context?: {
        message: MappedStreamEvent,
        user: UserRecord
      }) => {
        const cacheKey = (keyFunction ? stateConf.dataKey?.(propertyTarget, context ?? {}) : undefined) as string | undefined;
        if (this.stateCache.has(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget))) {
          const stateToTransfer = {
            stateType: stateTarget,
            stateData: await this.stateCache.get(stateTarget, this.cacheComposite(cacheKey ?? propertyTarget))
          };
          return !!(await this.transferChannel.dispatch(JSON.stringify(stateToTransfer), 'TRANSFER' as MessageType.TRANSFER, shardTarget, 'transfer'));
        } else {
          throw new Error(`State ${stateTarget as string}::${cacheKey} is not locally held`);
        }
      },
      broadcast: async (toStream, payload, sourceId) => {
        await this.outgoingChannel?.writeToStream({
          outgoingStream: toStream,
          incomingStream: undefined,
          messageType: 'BROADCAST' as MessageType.BROADCAST,
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
      console.info(`Handling state transformer event for message (${typeof streamMessage.payload}): `, streamMessage);
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
      console.info('Got response for handler: ', response);
      return {
        ...streamMessage,
        messageType: 'resp' as MessageType,
        payload: response
      };
    });
  }

  override async disconnect() {
    await Promise.all([
      super.disconnect(),
      this.stateCache.disconnect()
    ]);
  }

  override async connectAndListen() {
    await Promise.all([
      super.connectAndListen(),
      this.stateCache.connect()
    ]);
  }
}
