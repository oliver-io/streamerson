import {StreamMessageFlowModes} from '@streamerson/core';
import {test} from 'node:test';
import assert from 'node:assert';
import {ConsumerGroupMember} from "../src/member";
import {ConsumerGroupTopic} from "../src/group";
import {makeTestMessage, spyForConsumerGroupMessage} from "./helpers";

test('one consumer group member should get one message when published', async () => {
    // TODO: clean up all this configuration bloat
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

    await consumerGroup.connect();

    const consumerGroupMember = new ConsumerGroupMember({
        topic: consumerGroup,
        groupMemberId: 'test-id',
        bidirectional: true,
        eventMap: {}
    });

    const testMessage = {hello: 'world'};
    const testMessageId = 'test-message-id';
    const spy = await spyForConsumerGroupMessage(consumerGroupMember, makeTestMessage({
        stream: 'test',
        id: testMessageId,
        type: 'data',
        payload: testMessage
    }));

    assert.equal(spy.mock.calls.length, 1);
    assert.deepEqual(spy.mock.calls[0], {payload: testMessage, messageId: testMessageId});
});
