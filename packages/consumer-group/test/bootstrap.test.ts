import { createConsumerGroupConfig } from '../src/config';
import { ConnectedTopic, MessageType, StreamMessageFlowModes } from '@streamerson/core';
import { test } from 'node:test';
import {ConsumerGroup} from "../src/group";
import {ConsumerGroupMember} from "../src/member";

test('a consumer group can be created', async () =>{
    const config = createConsumerGroupConfig({
        name: 'test',
        min: 1,
        max: 1,
        processingTimeout: 0,
        idleTimeout: 0
    });

    const topic = new ConnectedTopic({
        topic: 'test',
        namespace: 'test',
        mode: 'ORDERED' as StreamMessageFlowModes
    });

    await topic.connect();

    const consumerGroup = new ConsumerGroup(config, topic);
    await consumerGroup.create(topic);
    await topic.disconnect();
});

test('a consumer group can be read from by a single consumer', async () =>{
    const config = createConsumerGroupConfig({
        name: 'test',
        min: 1,
        max: 1,
        processingTimeout: 0,
        idleTimeout: 0
    });

    const topic = new ConnectedTopic({
        topic: 'test',
        namespace: 'test',
        mode: 'ORDERED' as StreamMessageFlowModes
    });

    await topic.connect();

    // TODO: clean up all this configuration bloat
    const consumerGroup = new ConsumerGroup(config, topic);
    const instanceConfig = {
        groupId: config.name,
        groupMemberId: 'hello'
    };
    await consumerGroup.create(topic);

    const groupMember = new ConsumerGroupMember({
        topic,
        consumerGroupInstanceConfig: instanceConfig,
        bidirectional: true,
        eventMap: { 'data': ()=>{
            return {ok: 'test passed'}
        }}
    });

    await topic._channel.writeToStream(
      topic.consumerKey(),
      undefined,
      'data' as MessageType,
      '123-456',
       '{ "hello": "world" }',
      "from-tests"
    );

    await groupMember.connectAndListen({ consumerGroupInstanceConfig: instanceConfig });
});


