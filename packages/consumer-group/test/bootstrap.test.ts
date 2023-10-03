import { createConsumerGroupConfig } from '../src/config';
import {ConnectedTopic, StreamMessageFlowModes} from '@streamerson/core';
import { test } from 'node:test';
import {ConsumerGroup} from "../src/group";

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
