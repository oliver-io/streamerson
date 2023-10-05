import {ConsumerGroupInstanceConfig, MappedStreamEvent, StreamingDataSource} from "@streamerson/core";
import {EventMapRecord, StreamConsumer, StreamConsumerOptions} from "@streamerson/consumer"
import {ConsumerGroupTopic} from "./group";

type ConsumerGroupMemberOptions<E extends EventMapRecord> = StreamConsumerOptions<E> & {
    topic: ConsumerGroupTopic,
    groupMemberId: string
}

export class ConsumerGroupMember<E extends EventMapRecord> extends StreamConsumer<E> {
    instanceConfig: ConsumerGroupInstanceConfig
    _channel: StreamingDataSource;
    constructor(
        public override options: ConsumerGroupMemberOptions<E>
    ) {
        super({
            ...options,
            consumerGroupInstanceConfig: options.topic.instanceConfig(options.groupMemberId)
        });
        this.instanceConfig = options.topic.instanceConfig(options.groupMemberId);
        this._channel = this.options.topic._channel;
    }

    override async process(streamMessage: MappedStreamEvent) {
        if (!this.options.consumerGroupInstanceConfig?.groupId) {
            throw new Error("Cannot process consumer group message without group member ID");
        }
        const result = await super.process(streamMessage);
        if (result) {
            await this.incomingChannel.markProcessedByGroup(
                this.topic,
                this.options.consumerGroupInstanceConfig.groupId,
                streamMessage.streamMessageId!,
                this.options.shard
            );
        }
        return result;
    }

    override async connectAndListen(): Promise<void> {
        return super.connectAndListen({ consumerGroupInstanceConfig: this.instanceConfig });
    }

    clone(options?: Partial<ConsumerGroupMemberOptions<E>>) {
        return new ConsumerGroupMember({
            ...this.options,
            ...options
        });
    }
}