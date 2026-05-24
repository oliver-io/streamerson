import { DeferralTracker, StreamersonLogger } from '..';
import { type MappedStreamEvent, type MessageType, type StreamConfiguration } from '../types';
import { ids } from '../utils/ids';
import { shardDecorator } from '../utils/keys';

type streamAwaiterOptions = Omit<StreamConfiguration, 'outgoingStream'> & {
  logger?: StreamersonLogger;
  outgoingStream?: string;
  timeout?: number;
  concurrency?: number;
};

export class StreamAwaiter<T extends MappedStreamEvent> implements streamAwaiterOptions {
  public stateTracker;
  outgoingStream;
  incomingStream;
  writeChannel;
  readChannel;

  // promiseQueue: { add: (fn: () => Promise<T>) => Promise<T> };

  constructor(public options: streamAwaiterOptions) {
    this.stateTracker = new DeferralTracker(options);
    this.outgoingStream = options.outgoingStream;
    this.incomingStream = options.incomingStream;
    this.writeChannel = options.writeChannel;
    this.readChannel = options.readChannel;
    // this.promiseQueue = new PQueue({concurrency: options.concurrency ?? 1});
  }

  async dispatch(
    message: string,
    messageType: MessageType,
    messageSourceId?: string,
    shard?: string,
    outgoingStreamOverride?: string
  ) {
    const target = this.outgoingStream ?? outgoingStreamOverride;
    if (!target) {
      throw new Error(
        'Either a configured or override stream target must be provided'
      );
    }

    const id = ids.guuid();
    const $expectedResponse = this.stateTracker.promise(id) as Promise<T>;

    // Remove the tracker entry (and its armed timeout) on EVERY outcome — success, a
    // dispatch timeout, or a writeToStream failure. Deleting only on success leaks the
    // promise-map entry on every rejection (a gateway under timeout load grows unbounded).
    try {
      await this.writeChannel.writeToStream({
        outgoingStream: target,
        incomingStream: this.incomingStream,
        messageType: messageType,
        messageId: id,
        message,
        sourceId: messageSourceId ?? '',
        shard
      });
      const deferredResponse = await $expectedResponse;
      return deferredResponse!.payload;
    } finally {
      this.stateTracker.delete(id);
    }
  }

  /**
   * Begin routing responses on the incoming stream into the deferral tracker. Returns a
   * disposer that stops the reader and detaches its `keyEvents` listeners (it otherwise
   * runs until process exit — F8). Uses the same flowing `.on('data')` routing as the
   * `streamAwaiter` factory: correlation is by `messageId`, so read ordering is moot.
   * The disposer aborts `readChannel` (CANCEL — the only mechanism that stops an idle
   * read loop), so it assumes the awaiter owns that channel's read side.
   */
  async readResponseStream(shard?: string): Promise<() => void> {
    const stream = this.readChannel.getReadStream({
      stream: shardDecorator({ key: this.incomingStream, shard })
    });
    const onData = (event: T) => { this.stateTracker.emit('response', event); };
    stream.on('data', onData);
    return () => { stream.off('data', onData); void this.readChannel.abort(); };
  }
}

export const streamAwaiter = <T extends MappedStreamEvent>(
  options: streamAwaiterOptions
) => {
  const stateTracker = new DeferralTracker(options);
  const { outgoingStream, incomingStream, writeChannel, readChannel } = options;

  return {
    stateTracker,
    async dispatch(
      message: string,
      messageType: MessageType,
      messageSourceId?: string,
      shard?: string,
      outgoingStreamOverride?: string
    ) {
      const target = outgoingStream ?? outgoingStreamOverride;
      if (!target) {
        throw new Error(
          'Either a configured or override stream target must be provided'
        );
      }

      const id = ids.guuid();
      const $expectedResponse = stateTracker.promise<T>(id);

      // Remove the tracker entry (and its armed timeout) on EVERY outcome — success, a
      // dispatch timeout, or a writeToStream failure. Deleting only on success leaks the
      // promise-map entry on every rejection (a gateway under timeout load grows unbounded).
      try {
        await writeChannel.writeToStream({
          outgoingStream: target,
          incomingStream,
          messageType,
          messageId: id,
          message,
          sourceId: messageSourceId ?? '',
          shard
        });
        const deferredResponse = await $expectedResponse;
        return deferredResponse!.payload;
      } finally {
        stateTracker.delete(id);
      }
    },
    /**
     * Begin routing responses into the deferral tracker. Returns a disposer that stops
     * the reader and detaches its `keyEvents` listeners (it otherwise runs until process
     * exit — F8). Callers that `await`/`.catch()` the returned promise still work; the
     * resolved value is the disposer. The disposer aborts `readChannel` (CANCEL — the
     * only mechanism that stops an idle read loop), so it assumes the awaiter owns that
     * channel's read side (as the fastify gateway provisions it: one channel per awaiter).
     */
    async readResponseStream(shard?: string): Promise<() => void> {
      const stream = readChannel.getReadStream({
        stream: shardDecorator({ key: incomingStream, shard })
      });
      const onData = (e: T) => { stateTracker.emit('response', e); };
      stream.on('data', onData);
      return () => { stream.off('data', onData); void readChannel.abort(); };
    }
  };
};
