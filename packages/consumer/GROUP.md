# @streamerson/consumer

> Redis stream "consumer groups" as bidi Typescript Read/Writables

Part of a larger monorepo, this package provides a Typescript implementation for reading from Redis Streams-- as a member of a consumer group.  This package provides an interface for constructing objects that can be treated as streams / EventEmitters, but are under-the-hood statelessly reading (in a distributed way) from a Redis stream with guaranteed once-only delivery (except in failures / retries).

# Table of Contents
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


- [Installation](#installation)
- [Example](#example)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation

- `bun add @streamerson/consumer`

## Example

The following example will create a consumer group against a given stream in Redis (a serverside operation which starts to track message delivery & acknowledgement for each member).

This example binds an event handler to `"my-event"`, which means that if the consumer gets a message from the stream with a matching `type: "my-event"` field, it will run the arbitrary logic from its handler.  In this example, we just log out some info upon receiving these events:

<!-- BEGIN-CODE: ../examples/consumers/groups/consumer-group-readable.ts -->
[**consumer-group-readable.ts**](../examples/consumers/groups/consumer-group-readable.ts)
```typescript
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

```
<!-- END-CODE: ../examples/consumers/groups/consumer-group-readable.ts -->

Note that the `groupMemberId` field (here set to `"consumer-1"`) indicates which member of the group is connected.  We could create more of these with different IDs, and they would each be guaranteed to receive *different* messages from Redis.  That guarantee comes not from this package, but from the implementation of Redis streams themselves; this code just wraps around the actual client layer, delivering an interface for working with streams in an event-oriented way.  Under the hood, these types extend the `EventEmitter` class and are thus able to be read, piped, and *etc.* as per normal streams.
