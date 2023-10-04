import { createConsumerGroupConfig } from '../src/config';
import { ConnectedTopic, MessageType, StreamMessageFlowModes } from '@streamerson/core';
import { test, mock } from 'node:test';
import assert from 'node:assert';
import {ConsumerGroupMember} from "../src/member";
import {ConsumerGroupTopic} from "../src/group";

test('a consumer group can be created', async () =>{
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

test('a consumer group can be read from by a single consumer', async () =>{
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

    // TODO: probably do a `MKSTREAM` here:
    await consumerGroup.create();
    let free:(value: any)=>void;
    let $freed = new Promise((resolve, reject)=> {
        free = resolve;
        setTimeout(reject, 5000);
    })

    const hasBeenCalled = mock.fn((data: any)=>{
        return (free(null), {
            ok: true
        });
    });

    const consumerGroupMember = new ConsumerGroupMember({
        topic: consumerGroup,
        groupMemberId: 'test-id',
        bidirectional: true,
        eventMap: { 'data': hasBeenCalled }
    });

    const testMessge = { hello: 'world' };
    const testMessageId = 'test-message-id';

    // Test data stream entry:
    await consumerGroup._channel.writeToStream(
        consumerGroup.consumerKey(),
      undefined,
      'data' as MessageType,
      testMessageId,
       JSON.stringify(testMessge),
      "from-tests"
    );

    await consumerGroupMember.connectAndListen();
    await $freed;
    assert.equal(hasBeenCalled.mock.calls.length, 1);
    assert.deepEqual(hasBeenCalled.mock.calls[0], { payload: testMessge, messageId: testMessageId });
});


