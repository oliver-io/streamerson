import {ConsumerGroupConfig} from "./consumer-group-config";
import {MappedStreamEvent, Topic} from "@streamerson/core";
import {EventMapRecord, StreamConsumer, StreamConsumerOptions} from "@streamerson/consumer"
class ConsumerGroupMember<E extends EventMapRecord> extends StreamConsumer<E> {
    constructor(
        public override options: ConsumerGroupConfig & StreamConsumerOptions<E>,
        override public topic: Topic
    ) {
        super(options);
    }

    override async process(streamMessage: MappedStreamEvent) {
        const result = await super.process(streamMessage);
        // check result for errors
        // do stream checkin here
        return result;
    }
}