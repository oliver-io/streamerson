import {ConsumerGroupConfig, ConsumerGroupOptions, createConsumerGroupConfig} from "./config";
import {ConnectedTopic, Topic, TopicOptions} from "@streamerson/core";

export class ConsumerGroupTopic extends ConnectedTopic {
    config: ConsumerGroupConfig;
    constructor(
        topicOptions: TopicOptions,
        config: ConsumerGroupOptions,
    ) {
        super(topicOptions);
        this.config = createConsumerGroupConfig(config);
    }

    async create(cursor?: string, shard?: string) {
        // TODO: add a parameter to the public options of this class that dictates
        // if we want to check for the existence of a group before we try to create it;
        // in long-running applications, this would only technically really need done once,
        // but it make stable to do it every time with an optimized check quick for exist
        await this.channel.createConsumerGroup({
            stream: this.consumerKey(shard),
            groupId: this.config.name,
            cursor
        });
    }

    instanceConfig(groupMemberId: string) {
        return {
            groupId: this.config.name,
            groupMemberId
        }
    }
}