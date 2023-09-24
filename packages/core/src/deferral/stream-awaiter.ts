import {type Logger} from 'pino';
import {DeferralTracker} from '..';
import {v4 as uuid} from 'uuid';
import {type MappedStreamEvent, type MessageType, type StreamConfiguration} from '../types';
import {shardDecorator} from '../utils/keys';

type StreamAwaiterOptions = Omit<StreamConfiguration, 'outgoingStream'> & {
	logger?: Logger;
	outgoingStream?: string;
	timeout?: number;
};

export const streamAwaiter = <T extends MappedStreamEvent>(
	options: StreamAwaiterOptions,
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

			const id = uuid();
			let $expectedResponse = stateTracker.promise<T>(id);
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
			// @ts-expect-error:: explicitly tell the gc to get rid of our interior promise
			$expectedResponse = null;
			stateTracker.delete(id);
			return deferredResponse.payload;
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
