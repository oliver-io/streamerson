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

  constructor(public options: Topic | TopicOptions | string) {
    if (typeof options === 'object' && 'meta' in options && typeof options.meta === 'function') {
      const clone = (options as Topic);
      this.namespace = clone.namespace;
      this.mode = clone.mode;
      this.topic = clone.topic;
    } else if (typeof options === 'string') {
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

  loopback() {
    const loopback = new Topic(this)
    const oldConsumerKey = loopback.consumerKey.bind(loopback)
    const oldProducerKey = loopback.producerKey.bind(loopback);
    loopback.consumerKey = oldProducerKey;
    loopback.producerKey = oldConsumerKey;
    return loopback;
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

  /**
   * Dead-letter stream for this topic (and shard). A plain stream (no group):
   * terminally-failed and abandoned entries are recorded here with cause +
   * provenance, drained to SQL by reverse-streamers. See REQUEST_STREAM_RECEIPT.md §4.
   */
  deadLetterKey(shard?: string): string {
    return `${keyGenerator({
      namespace: this.namespace,
      key: shardDecorator({ key: this.topic, shard })
    })}::DEAD_LETTER`;
  }

  subtopic(topic: string) {
    return new Topic(typeof this.options === 'string' ? `${this.topic}(${topic})` : {
      ...this.options,
      topic: `${this.topic}(${topic})`
    });
  }
}
