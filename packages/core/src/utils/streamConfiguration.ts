import {
	type StreamConfiguration,
	type StreamersonLogger,
	type StreamOptions,
} from '../types';
import {StreamingDataSource} from '../datasource';
import {keyGenerator} from './keys';

export function buildStreamConfiguration(
	conf: StreamOptions,
	options: {logger: StreamersonLogger} = {logger: console},
): StreamConfiguration {
	const {namespace} = conf.meta;
	const outgoingStream = `${keyGenerator({
		namespace,
		key: conf.streamKey,
	})}_OUTGOING`;
	const incomingStream = `${keyGenerator({
		namespace,
		key: conf.streamKey,
	})}_INCOMING`;

	return {
		...conf,
		readChannel:
      conf.channels?.readChannel
      ?? new StreamingDataSource({
      	...conf.redisConfiguration,
      	logger: options.logger,
      	// TODO: figure out these options so that the default is not true
      	controllable: true,
      }),
		writeChannel:
      conf.channels?.writeChannel
      ?? new StreamingDataSource({
      	...conf.redisConfiguration,
      	logger: options.logger,
      }),
		incomingStream,
		outgoingStream,
	};
}
