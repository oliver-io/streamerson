import {DeferralTracker, StreamersonLogger} from '..';
import {type MappedStreamEvent, type MessageType, type StreamConfiguration} from '../types';
import {ids} from '../utils/ids';
import {shardDecorator} from '../utils/keys';

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
    outgoingStreamOverride?: string,
  ) {
    const target = this.outgoingStream ?? outgoingStreamOverride;
    if (!target) {
      throw new Error(
        'Either a configured or override stream target must be provided',
      );
    }

    const id = ids.guuid();
    let $expectedResponse = (
      // this.promiseQueue ?
      //   this.promiseQueue.add(() => (this.stateTracker.promise(id))) :
        this.stateTracker.promise(id)
    ) as Promise<T> | null;

    await this.writeChannel.writeToStream(
      target,
      this.incomingStream,
      messageType,
      id,
      message,
      messageSourceId ?? '',
      shard,
    );

    const deferredResponse = await $expectedResponse;
    // Todo: consider using a weakmap here to avoid memory leaks, but for now:
    $expectedResponse = null;
    this.stateTracker.delete(id);
    return deferredResponse!.payload;
  }

  async readResponseStream(shard?: string) {
    for await (const event of this.readChannel.getReadStream({
      stream: shardDecorator({key: this.incomingStream, shard}),
    })) {
      this.stateTracker.emit('response', event);
    }
  }
}

export const streamAwaiter = <T extends MappedStreamEvent>(
  options: streamAwaiterOptions,
) => {
  const stateTracker = new DeferralTracker(options);
  const {outgoingStream, incomingStream, writeChannel, readChannel} = options;

  return {
    stateTracker,
    async dispatch(
      message: string,
      messageType: MessageType,
      messageSourceId?: string,
      shard?: string,
      outgoingStreamOverride?: string,
    ) {
      const target = outgoingStream ?? outgoingStreamOverride;
      if (!target) {
        throw new Error(
          'Either a configured or override stream target must be provided',
        );
      }

      const id = ids.guuid();
      let $expectedResponse = (stateTracker.promise<T>(id) as ReturnType<typeof stateTracker.promise<T>> | null);
      await writeChannel.writeToStream(
        target,
        incomingStream,
        messageType,
        id,
        message,
        messageSourceId ?? '',
        shard,
      );
      const deferredResponse = await $expectedResponse;
      // Todo: consider using a weakmap here to avoid memory leaks, but for now:
      $expectedResponse = null;
      stateTracker.delete(id);
      return deferredResponse!.payload;
    },
    async readResponseStream(shard?: string) {
      // If we aren't in ordered mode, I think something like this is more appropriate:
      const stream = readChannel.getReadStream({
        stream: shardDecorator({key: incomingStream, shard}),
      });

      stream.on('data', (e)=>{
        stateTracker.emit('response', e);
      });

      // // For ordered mode??
      // for await (const event of readChannel.getReadStream({
      //   stream: shardDecorator({key: incomingStream, shard}),
      // })) {
      //   stateTracker.emit('response', event);
      // }
    },
  };
};
