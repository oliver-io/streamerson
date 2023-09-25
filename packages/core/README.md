# @streamerson/core
> For Doing Cool & Idiomatic Things with Streams, Maybe

# Overview

This package was created as a core SDK for my smoother-brained endeavours, some of which is documented in the [Streamerson Examples](../examples/README.md). Give it a read, or skip it-- this package exists on its own and might be helpful.

Some quick notes:
- All Typescript
- Meant for `node v20+`
- All the current code relies on `redis` at a version higher than `6`.  
- In the future, the `Topic` interface will be extended to work with more than Redis streams probably.  I have my sights on `AWS:SQS` first, because cheap and fast and Kinesis sucks.
- Unfinished -- believe the package version being sub-`1`.
- Lots of high-hanging fruit for low-level optimizations around asynchronicity, network connection pooling, ser/des, memory management, potential for hanging promises, etc.  This is a fairly crunchy project and I've just been getting to these things as I have time. 

# Table of Contents
-- yet to be generated when i can figure out why windows broke all my binaries

# Installation

- Install the core SDK in your package of choice:
```bash
yarn add @streamerson/core
```
- Import some stuff, get streamin'.  The following example will connect to Redis and begin listening for events with a type `hello` on a stream `Topic`, responding in kind with some JSON:
```typescript
import { StreamingDataSource, Topic } from '@streamerson/core';

const readChannel = new StreamingDataSource(/* optional options */);

await readChannel.connect();

for await (const event of readChannel.getReadStream({
    // ... optional options, like batch size and timeouts
    topic: new Topic('my-example-topic')
})) {
    readChannel.logger.info(event, 'Received event!')
    // Do something with my streamed event?
    // We could even `.pipe()` this event to a Writeable.
}
```
- And you're ... streaming with gas? Of course, this is relying on default connection settings and the existence of a Redis server.  In this monorepo, there are tools for starting a Redis Docker image, and there are connection options built into the parameters of all the functions for connecting to a non-defaulted Redis instance.


