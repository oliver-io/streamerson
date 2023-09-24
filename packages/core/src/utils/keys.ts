import {type BareStreamKey} from '../types';

export function keyGenerator(options: {
	namespace: string;
	key: string;
}): BareStreamKey {
	return `${options.namespace}::${options.key}`;
}

export function shardDecorator(options: {
	key: BareStreamKey;
	shard?: string;
}) {
	return options.shard ? `${options.key}#${options.shard}` : options.key;
}
