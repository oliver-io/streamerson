import {MappedStreamEvent, StreamMessageFlowModes} from '@streamerson/core';
import {test, mock} from 'node:test';
import assert from 'node:assert';
import {ConsumerGroupMember} from "../src/member";
import {ConsumerGroupTopic} from "../src/group";
import {makeTestMessage, spyForConsumerGroupMessage, waitFor} from "./helpers";

const consumerGroup = new ConsumerGroupTopic({
    topic: 'test',
    namespace: 'test',
    mode: 'ORDERED' as StreamMessageFlowModes
}, {
    name: 'test-group',
    min: 1,
    max: 1,
    processingTimeout: 0,
    idleTimeout: 0
});

const [t1, t2, t3] = [
    makeTestMessage({
        stream: consumerGroup.consumerKey(),
        id: '1',
        payload: {hello: 'world'},
        type: 'data'
    }),
    makeTestMessage({
        stream: consumerGroup.consumerKey(),
        id: '2',
        payload: {iam: 'a test'},
        type: 'data'
    }),
    makeTestMessage({
        stream: consumerGroup.consumerKey(),
        id: '3',
        payload: {goodbye: 'world'},
        type: 'data'
    })
];

const decentlyLongFunction = async (m: MappedStreamEvent) => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return {
        ...m,
        payload: JSON.stringify({
            OK: true
        })
    };
};

test('a consumer group should get old messages published before connection', async () => {

    const spy = mock.fn(decentlyLongFunction);
    await consumerGroup.connect();

    const consumer = new ConsumerGroupMember({
        topic: consumerGroup,
        groupMemberId: 'test-id',
        bidirectional: true,
        eventMap: {
            'data': spy
        }
    });

    // Write our test data to the streams, which should get picked up by our consumer group:\
    await consumerGroup._channel.writeToStream(...t1);
    await consumerGroup._channel.writeToStream(...t2);
    await consumerGroup._channel.writeToStream(...t3);

    await consumer.connectAndListen();

    await waitFor(1000);

    // The 'data' event was bound to our spies, which should have been called:
    assert.equal(spy.mock.calls.length, 3);

    // Cleanup:
    await Promise.all([
        consumerGroup.disconnect(),
        consumer.disconnect()
    ]);
});
