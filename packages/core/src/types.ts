import {type Logger} from 'pino';
import {type Readable, type Writable} from 'stream';
import {type Redis as RedisClient} from 'ioredis';
import {type StreamingDataSource} from './datasource/streamable';

// For clarity in signatures:
export type MessageId = string; // UUID e.g. 'f8b8f8b8-f8b8-f8b8-f8b8-f8b8f8b8f8b8'
export type StreamMessageId = string; // Redis stream entry ID e.g. '1923456789-0'
export type StreamId = string;
export type SourceId = string;
export enum MessageType {
	TRANSFER = 'xfer',
	RESPONSE = 'resp',
	LOGIN = 'login',
	JOIN = 'join',
	SOCKET = 'sock',
	BROADCAST = 'xcast',
}

export enum StreamMessageFlowModes {
	REALTIME = 'REALTIME',
	ORDERED = 'ORDERED',
}

export type StreamMeta = {
	namespace: string;
	sharded: boolean;
	mode: StreamMessageFlowModes;
};

export type BareStreamKey = string;
export type ShardedStreamKey = string;

export type NonNullablePrimitive = number | string | boolean | bigint | Buffer;
export type NullablePrimitive = NonNullablePrimitive | undefined;

export type StreamEventData = [_id: string, messaage: StreamResponseArray];

export type BulkArrayRawStreamEvent = [
  streamName: string,
  streamEvents: StreamEventData[],
];

export type RawStreamEventCollection = [
  streamName: string,
  streamEvents: StreamEventData[],
];

type StreamHeaders = Buffer | 'nil';

type MessageProtocol = 'json' | 'text';

export type MappedStreamEvent<
	T = MessageType,
	R = Record<string, NullablePrimitive>,
	H = StreamHeaders,
> = {
	messageId: MessageId;
	messageType: T;
	messageDestination: StreamId;
	payload: R;
	messageProtocol: MessageProtocol;
	messageSourceId: SourceId;
	streamId?: StreamId;
	streamMessageId?: StreamMessageId;
	messageHeaders?: H;
};

export type StreamResponseArray = [
	StreamId,
	MessageType,
	StreamId,
	StreamHeaders | '',
	MessageProtocol,
	SourceId,
	'UnoccupiedField',
	string | Buffer,
];

export type StreamRequestArray = [
  messageId: string,
  messageType: MessageType,
  messageDestination: StreamId,
];

export type IncomingChannel = Readable & {readableObjectMode: true};
export type OutgoingChannel = Writable & {writableObjectMode: true};
export type ChannelTupleArray = Array<
[channel: IncomingChannel | OutgoingChannel, label: string]
>;

export enum StateObjectTypes {
	StandaloneString = 'standalone-string',
	StandaloneNumber = 'standalone-number',
	StandaloneBoolean = 'standalone-boolean',
	StandaloneBigInt = 'standalone-bigint',
	StandaloneHash = 'standalone-hash',
	CollectionString = 'collection-string',
	CollectionNumber = 'collection-number',
	CollectionBoolean = 'collection-boolean',
	CollectionBigInt = 'collection-bigint',
	CollectionHash = 'collection-hash',
}

export type StreamOptions = {
	meta: StreamMeta;
	streamKey: string;
	redisConfiguration: any;
	channels?: {
		readChannel: StreamingDataSource;
		writeChannel: StreamingDataSource;
	};
};

export type StreamConfiguration = {
	incomingStream: string;
	outgoingStream: string;
	readChannel: StreamingDataSource;
	writeChannel: StreamingDataSource;
	redisConfiguration?: any;
};

export type StreamersonLogger = Logger | typeof console;

export type KeyOptions = {
	key: string;
	shard?: string;
};

export type ConsumerGroupInstanceConfig = {
	groupId: string,
	groupMemberId: string;
};

export type MaybeConsumerGroupInstanceConfig = {
	consumerGroupInstanceConfig?: ConsumerGroupInstanceConfig
};

export type BlockingStreamBatchMapOptions = {
	stream?: string;
	shard?: string;
	last?: string | Record<string, string>;
	requestedBatchSize?: number;
	blockingTimeout?: number;
} & MaybeConsumerGroupInstanceConfig;

export type BlockingStreamBatchResponse = {
	cursor: string | Record<string, string>;
	events: Array<MappedStreamEvent | string>;
};

export type DataSourceOptions = {
	getConnection?: () => RedisClient;
	port: number;
	host: string;
	logger: Logger;
	controllable?: boolean;
};

export type ConnectableDataSource = {
	options: DataSourceOptions;
	connect: () => Promise<ConnectableDataSource>;
};

export type DataSource = {
	get: (key: string, shard?: string) => Promise<string | undefined >;
	set: (options: KeyOptions, value: string) => Promise<boolean>;
};

export type StreamableDataSource = {
	blockingStreamBatchMap: (
		options: BlockingStreamBatchMapOptions
	) => Promise<BlockingStreamBatchResponse>;
} & DataSource;
