import {StreamMessageFlowModes, StreamMeta, StreamOptions} from "../types";
import {consumerProducerDecorator, keyGenerator, shardDecorator} from "./keys";
import {StreamingDataSource} from "../datasource/streamable";

export type TopicOptions = {
    namespace: string,
    topic?: string,
    mode?: StreamMessageFlowModes,
};

export class Topic {
    topic: string;
    mode: StreamMessageFlowModes;
    namespace: string;
    constructor(public options: TopicOptions | string) {
        if (typeof options === 'string') {
            this.namespace = options;
            this.topic = 'DEFAULT';
            this.mode = StreamMessageFlowModes.ORDERED;
        } else {
            this.namespace = options.namespace;
            this.topic = options.topic ?? 'DEFAULT';
            this.mode = options.mode ?? StreamMessageFlowModes.ORDERED;
        }
    }
    meta(shard?: string): StreamMeta {
        return {
            namespace: this.namespace,
            sharded: !!shard,
            mode: this.mode,
        }
    }

    consumerKey(shard?: string): string {
        return consumerProducerDecorator({
            consumerOrProducer: 'CONSUMER',
            direction: 'INCOMING',
            key: keyGenerator({
                namespace: this.namespace,
                key: shardDecorator({
                    key: this.topic,
                    shard
                })
            })
        })
    }

    producerKey(shard?: string): string {
        return consumerProducerDecorator({
            consumerOrProducer: 'PRODUCER',
            direction: 'OUTGOING',
            key: keyGenerator({
                namespace: this.namespace,
                key: shardDecorator({
                    key: this.topic,
                    shard
                })
            })
        })
    }

    subtopic(topic: string) {
        return new Topic(typeof this.options === 'string' ? `${this.topic}(${topic})` : {
            ... this.options,
            topic: `${this.topic}(${topic})`
        });
    }
}

export class ConnectedTopic extends Topic {
    _channel: StreamingDataSource;
    connected: boolean;
    private readonly _$connected?: Promise<void>;
    constructor(
        public override options: TopicOptions,
        private channelOption?: StreamingDataSource | ConstructorParameters<typeof StreamingDataSource>[0]
    ) {
        super(options);
        this._channel = channelOption instanceof StreamingDataSource ?
            channelOption :
            new StreamingDataSource(channelOption);

        this.connected = false;
        this._$connected = this._channel.connect().then();
    }

    async connect() {
        // TODO: handle some kind of disconnection subscription here:
        await this._$connected;
        this.connected = true;
    }

    async disconnect() {
        await this._channel.disconnect();
    }

    get channel() {
        if (!this.connected) {
                throw new Error("Channel not connected; call ConnectableTopic.connect() first");
        }

        return this._channel;
    }

    async clone() {
        const topic = new ConnectedTopic(this.options, this.channelOption);
        await topic.connect();
        return topic;
    }
}
