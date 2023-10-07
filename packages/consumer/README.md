# @streamerson/consumer

> A Typescript stream consumer/producer for Redis & the [@streamerson](../../README.md) framework

This module exposes some high-level Typescript classes for reading from Redis streams as Readable Streams (in Node.JS).  The exported classes are essentially utility wrappers around the lower-level objects supplied by [@streamerson/core](../core/README.md).  Direct usage of those low-level modules is possible but not encouraged, as these are (meant to be) a stable, configurable & clean interface over low-level and rather gross underlying components.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Usage](#usage)
  - [See Also: Streamerson](#see-also-streamerson)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Usage

- `yarn add @streamerson/consumer`

<!-- BEGIN-CODE: ../examples/consumers/single-uni/consumer-with-framework.example.ts -->
[**consumer-with-framework.example.ts**](../examples/consumers/single-uni/consumer-with-framework.example.ts)
```typescript
import { Topic } from '@streamerson/core';
import { StreamConsumer } from '@streamerson/consumer';

const consumer = new StreamConsumer({
    topic: new Topic('my-stream-topic'),
    bidirectional: false,
    eventMap: {
        ['hello']: (e) => {
            console.log('I just got an event!')
        }
    }
});

await consumer.connectAndListen();
```
<!-- END-CODE: ../examples/consumers/singlel-uni/consumer-with-framework.example.ts -->

## See Also: [Streamerson](https://github.com/oliver-io/streamerson)