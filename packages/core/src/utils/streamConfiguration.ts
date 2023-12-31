import {
	type StreamConfiguration,
	type StreamersonLogger,
	type StreamOptions,
} from '../types';
import {StreamingDataSource} from '../datasource/streamable';
import {Topic} from "./topic";

export function buildStreamConfiguration(
	topic: Topic,
	options: {logger: StreamersonLogger} & Partial<StreamOptions> = {logger: console},
): StreamConfiguration {
	const {namespace, sharded, mode} = topic.meta();
	const incomingStreamName = topic.consumerKey();
	const outgoingStreamName = topic.producerKey();
	const readChannel = options.channels?.readChannel ?? new StreamingDataSource({
		logger: options.logger,
		controllable: true,
		... (options?.redisConfiguration ?? {})
	});

	const writeChannel = options.channels?.writeChannel ?? new StreamingDataSource({
		logger: options.logger,
		controllable: false,
		... (options?.redisConfiguration ?? {})
	});

	return {
		incomingStream: incomingStreamName,
		outgoingStream: outgoingStreamName,
		readChannel,
		writeChannel,
	};
}
