import {StreamMessageFlowModes} from '@streamerson/core';
// eslint-disable-next-line @nx/enforce-module-boundaries
import {test} from 'node:test';
import {ConsumerGroupConfigurator} from "../src/group";

test('a consumer group can be created', async () => {
    const consumerGroup = new ConsumerGroupConfigurator({
      topic: {
        topic: 'test',
        namespace: 'test'
      },
    }, {
        topic: 'test',
        namespace: 'test',
        mode: 'ORDERED' as StreamMessageFlowModes
    },{
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
