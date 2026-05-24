import { Topic } from '@streamerson/core';
import { ConsumerGroupCoordinator, ConsumerGroupMember } from '@streamerson/consumer';

const topic = new Topic('my-stream-topic');
const redisConfiguration = { host: 'localhost', port: 6379 };

// Create the consumer group server-side (idempotent: XGROUP CREATE … MKSTREAM).
// The coordinator only creates/maintains the group — it never consumes messages.
const coordinator = new ConsumerGroupCoordinator(
    { topic, redisConfiguration },
    { name: 'some-consumer-group', count: 1 },
);
await coordinator.connectAndListen();
await coordinator.create();

// Attach a member. Members of the same group are each delivered *different*
// messages (once-only delivery), guaranteed by Redis consumer groups. A member
// must read under a stable, non-empty consumer name.
const member = new ConsumerGroupMember(
    { topic, redisConfiguration },
    { groupId: 'some-consumer-group', groupMemberId: 'consumer-1' },
);

member.registerStreamEvent('my-event', (event) => {
    console.log('An event with type "my-event" was received:', event.payload);
});

await member.connectAndListen();
