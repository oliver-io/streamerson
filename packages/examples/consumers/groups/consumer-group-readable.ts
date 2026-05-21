import { Topic } from '@streamerson/core';
import { ConsumerGroupConfigurator, ConsumerGroupMember } from '@streamerson/consumer';

const topic = new Topic('my-stream-topic');
const redisConfiguration = { host: 'localhost', port: 6379 };

// Create the consumer group server-side (idempotent: XGROUP CREATE … MKSTREAM).
const group = new ConsumerGroupConfigurator(
    { topic, redisConfiguration },
    topic,
    { name: 'some-consumer-group', max: 1 },
);
await group.connectAndListen();
await group.create();

// Attach a member. Members of the same group are each delivered *different*
// messages (once-only delivery), guaranteed by Redis consumer groups.
const member = new ConsumerGroupMember(
    { topic, redisConfiguration },
    { groupId: 'some-consumer-group', groupMemberId: 'consumer-1', acknowledgeProcessed: true },
);

member.registerStreamEvent('my-event', (event) => {
    console.log('An event with type "my-event" was received:', event.payload);
});

await member.connectAndListen();
