import { ConsumerGroupTopic, ConsumerGroupMember } from '@streamerson/consumer-group';

const consumerGroup = new ConsumerGroupTopic({
    topic: 'my-stream-topic',
    namespace: 'examples',
    mode: 'ORDERED'
}, {
    name: 'some-consumer-group',
    min: 1,
    max: 1,
    processingTimeout: 0,
    idleTimeout: 0
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