import {ConsumerGroupConfig} from "./config";
import {MappedStreamEvent, Topic} from "@streamerson/core";
import {EventMapRecord, StreamConsumer, StreamConsumerOptions} from "@streamerson/consumer"
export class ConsumerGroupMember<E extends EventMapRecord> extends StreamConsumer<E> {
    constructor(
        public override options: StreamConsumerOptions<E>,
    ) {
        super(options);
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

    override async connectAndListen(options: {
        consumerGroupInstanceConfig: {
            groupId: string;
            groupMemberId: string
        }
    }): Promise<void> {
        return super.connectAndListen(options);
    }
}