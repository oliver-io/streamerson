import { type Logger } from 'pino';
import { DeferralTracker, StreamersonLogger, StreamingDataSource } from '..';
import { type MappedStreamEvent, type MessageType, type StreamConfiguration } from '../types';
import { ids } from '../utils/ids';
import { shardDecorator } from '../utils/keys';
import PQueue from 'p-queue';

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
  promiseQueue: { add: (fn: () => Promise<T>) => Promise<T> };

  constructor(public options: streamAwaiterOptions) {
    this.stateTracker = new DeferralTracker(options);
    this.outgoingStream = options.outgoingStream;
    this.incomingStream = options.incomingStream;
    this.writeChannel = options.writeChannel;
    this.readChannel = options.readChannel;
    this.promiseQueue = new PQueue({concurrency: options.concurrency ?? 1});
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
      this.promiseQueue ?
        this.promiseQueue.add(() => (this.stateTracker.promise<T>(id))) :
        this.stateTracker.promise<T>(id)
    ) as ReturnType<typeof DeferralTracker['promise']> | null;

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
			for await (const event of readChannel.getReadStream({
				stream: shardDecorator({key: incomingStream, shard}),
			})) {
				stateTracker.emit('response', event);
			}
		},
	};
};
