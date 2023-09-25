import {StreamMessageFlowModes, StreamMeta} from "../types";
import {consumerProducerDecorator, keyGenerator, shardDecorator} from "./keys";

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