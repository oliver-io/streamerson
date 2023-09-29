import {ConsumerGroupConfig} from "./config";
import {MappedStreamEvent, Topic} from "@streamerson/core";
import {EventMapRecord, StreamConsumer, StreamConsumerOptions} from "@streamerson/consumer"
export class ConsumerGroupMember<E extends EventMapRecord> extends StreamConsumer<E> {
    constructor(
        public override options: StreamConsumerOptions<E>,
        public override topic: Topic,
        public groupMemberId: string
    ) {
        super(options);
    }

    override async process(streamMessage: MappedStreamEvent) {
        if (!this.groupMemberId) {
            throw new Error("Cannot process consumer group message without group member ID");
        }
        const result = await super.process(streamMessage);
        if (result) {
            await this.incomingChannel.markProcessedByGroup(
                this.topic,
                this.groupMemberId,
                streamMessage.streamMessageId!,
                this.options.shard
            );
        }
        return result;
    }
}