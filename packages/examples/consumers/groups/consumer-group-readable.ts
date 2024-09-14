import { Topic } from '@streamerson/core';
import { ConsumerGroupTopic, ConsumerGroupMember } from '@streamerson/consumer';

const topic = new Topic('my-stream-topic');

const consumerGroup = new ConsumerGroupTopic(topic, {
    name: 'some-consumer-group',
    max: 1
});

await consumerGroup.connect();
await consumerGroup.create();

const consumerGroupMember = new ConsumerGroupMember({
    topic: consumerGroup,
    groupMemberId: 'consumer-1'
});

consumerGroupMember.registerStreamEvent('my-event', (data) => {
    console.log('An event with type "my-event" was received:')
    console.log(data);
});

await consumerGroupMember.connectAndListen();
