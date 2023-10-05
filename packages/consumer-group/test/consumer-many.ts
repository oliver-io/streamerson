import {MappedStreamEvent, StreamMessageFlowModes} from '@streamerson/core';
import {test, mock} from 'node:test';
import assert from 'node:assert';
import {ConsumerGroupMember} from "../src/member";
import {ConsumerGroupTopic} from "../src/group";
import {makeTestMessage, spyForConsumerGroupMessage} from "./helpers";

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


test('a consumer group of three should get one message each', async () => {
    const [spy1, spy2, spy3] = [
        mock.fn(decentlyLongFunction),
        mock.fn(decentlyLongFunction),
        mock.fn(decentlyLongFunction),
    ];

    await consumerGroup.connect();

    const m1 = new ConsumerGroupMember({
        topic: consumerGroup,
        groupMemberId: 'test-id',
        bidirectional: true,
        eventMap: {
            'data': spy1
        }
    });

    const m2 = m1.clone({
        groupMemberId: 'test-id-2',
        eventMap: {
            'data': spy2
        }
    });

    const m3 = m1.clone({
        groupMemberId: 'test-id-3',
        eventMap: {
            'data': spy3
        }
    });

    // At this point, all these guys should be pending on new entries for our consumer group:
    await Promise.all([
        m1.connectAndListen(),
        m2.connectAndListen(),
        m3.connectAndListen()
    ]);

    // Write our test data to the streams, which should get picked up by our consumer group:\
    await consumerGroup._channel.writeToStream(...t1);
    await consumerGroup._channel.writeToStream(...t2);
    await consumerGroup._channel.writeToStream(...t3);

    // TODO: Let's think about some kind of 'onData' event to .once on in the underlying layers,
    // to avoid waiting around for an arbitrary amount of time:
    await new Promise((resolve, reject)=>{
        setTimeout(resolve, 2000);
    })

    // The 'data' event was bound to our spies, which should have been called:
    assert.equal(spy1.mock.calls.length, 1);
    assert.equal(spy2.mock.calls.length, 1);
    assert.equal(spy3.mock.calls.length, 1);

    // Cleanup:
    await Promise.all([
        consumerGroup.disconnect(),
        m1.disconnect(),
        m2.disconnect(),
        m3.disconnect()
    ]);
});
