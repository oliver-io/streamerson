import {StreamMessageFlowModes} from '@streamerson/core';
import {test} from 'node:test';
import {ConsumerGroupTopic} from "../src/group";

test('a consumer group can be created', async () => {
    const consumerGroup = new ConsumerGroupTopic({
        topic: 'test',
        namespace: 'test',
        mode: 'ORDERED' as StreamMessageFlowModes
    }, {
        name: 'test',
        min: 1,
        max: 1,
        processingTimeout: 0,
        idleTimeout: 0
    });

    await consumerGroup.connect();
    await consumerGroup.create();
    await consumerGroup.disconnect();
});