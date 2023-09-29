import {ConsumerGroupConfig} from "./config";
import {ConnectedTopic, Topic} from "@streamerson/core";
import {ConsumerGroupMember} from "./member";

class ConsumerGroup {
    constructor(
        public config: ConsumerGroupConfig,
        public connectedTopic: ConnectedTopic
    ) { }

    async create(topic: Topic, cursor?: string, shard?: string) {
        // TODO: add a parameter to the public options of this class that dictates
        // if we want to check for the existence of a group before we try to create it;
        // in long-running applications, this would only technically really need done once,
        // but it make stable to do it every time with an optimized check quick for exist
        await this.connectedTopic.channel.createConsumerGroup({
            stream: topic.consumerKey(shard),
            groupId: this.config.name,
            cursor
        });
    }
}