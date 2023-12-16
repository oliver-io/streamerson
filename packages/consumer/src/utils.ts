import {StreamingDataSource, Topic} from "@streamerson/core";
import {ConsumerGroupConfig} from "./config";

export async function createConsumerGroup(
    channel: StreamingDataSource,
    topic: Topic,
    groupConfig: ConsumerGroupConfig,
    cursor?: string,
    shard?: string
){
    return await channel.createConsumerGroup({
        stream: topic.consumerKey(shard),
        groupId: groupConfig.name,
        cursor
    });
}
export async function acquireGroupMemberId(
    channel: StreamingDataSource,
    topic: Topic,
    groupConfig: ConsumerGroupConfig,
    shard?: string
) {
    const id = await channel.incr(
        `${topic.consumerKey(shard)}__GROUP(${groupConfig.name})`
    );

    if (!id) {
        throw new Error("Unable to INCR group member ID; cancelling startup");
    }

    if (id > groupConfig.max) {
        throw new Error("Group member ID is greater than max; cancelling startup");
    }

    return `${topic.consumerKey(shard)}__GROUP(${groupConfig.name}$${id})`
}