import {StreamMessageFlowModes, StreamMeta, StreamOptions} from "../types";
import {consumerProducerDecorator, keyGenerator, shardDecorator} from "./keys";
import {StreamingDataSource} from "../datasource/streamable";

export class Topic {
    topic: string;
    mode: StreamMessageFlowModes;
    namespace: string;
    constructor(public options: {
        namespace: string,
        topic?: string,
        mode?: StreamMessageFlowModes,
    }) {
        this.namespace = options.namespace;
        this.topic = options.topic ?? 'DEFAULT';
        this.mode = options.mode ?? StreamMessageFlowModes.ORDERED;
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
        return new Topic({
            ... this.options,
            topic: `${this.topic}(${topic})`
        })
    }
}

export class ConnectedTopic extends Topic {
    _channel: StreamingDataSource;
    connected: boolean;
    _$connected?: Promise<any>;
    constructor(
        options: ConstructorParameters<typeof Topic>[0],
        public channelOption?: StreamingDataSource | ConstructorParameters<typeof StreamingDataSource>[0]
    ) {
        super(options);
        this._channel = channelOption instanceof StreamingDataSource ?
            channelOption :
            new StreamingDataSource(channelOption);

        this.connected = false;
        this._$connected = this.connect();
    }

    async connect() {
        // TODO: handle some kind of disconnection subscription here:
        await this._$connected;
        this.connected = true;
    }

    get channel() {
        if (!this.connected) {
                throw new Error("Channel not connected; call ConnectableTopic.connect() first");
        }

        return this._channel;
    }
}