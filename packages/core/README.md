# @streamerson/core

> For Doing Cool & Idiomatic Things with Streams, Maybe

# Overview

This package was created as a core SDK for my smoother-brained endeavours, some of which is documented in
the [Streamerson Examples](../examples/README.md). Give it a read, or skip it-- this package exists on its own and might
be helpful.

Everything here is built for internal usage in the rest of the `@streamerson` packages.  However, those higher-level packages mostly wrap this core code, meaning that if my more use-case-driven tooling (the other monorepo packages) aren't of interest to you, maybe the low-level components here will help you build something too.

The idea for the exported code of this package is essentially to achieve the following:
- wrap Redis clients behind interfaces
- wrap reading/writing logic behind real Streams (Read/Writables)
- provide a set of un-opinionated tools for manipulating these Read/Writables
- instrument some basic utilities and helper functions to distribute to the rest of the monorepo

# Table of Contents
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


  - [Notes](#notes)
  - [Installation](#installation)
  - [Example](#example)
  - [API](#api)
    - [RedisDataSource](#redisdatasource)
    - [StreamingDataSource](#streamingdatasource)
    - [Promise Tracker](#promise-tracker)
    - [Stream Awaiter](#stream-awaiter)
    - [Utils](#utils)
- [API Reference](#api-reference)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Notes

Some quick notes:

- All Typescript
- Meant for `node v20+`
- All the current code relies on `redis` at a version higher than `6`.
- In the future, the `Topic` interface will be extended to work with more than Redis streams probably. I have my sights
  on `AWS:SQS` first, because cheap and fast and Kinesis sucks.
- Unfinished -- believe the package version being sub-`1`.
- Lots of high-hanging fruit for low-level optimizations around asynchronicity, network connection pooling, ser/des,
  memory management, potential for hanging promises, etc. This is a fairly crunchy project and I've just been getting to
  these things as I have time.

## Installation

- Install the core SDK in your package of choice:

```bash
yarn add @streamerson/core
```

- Import some stuff, get streamin'. The following example will connect to Redis and begin listening for events with a
  type `hello` on a stream `Topic`, responding in kind with some JSON:

## Example
<!-- BEGIN-CODE: ../examples/core-modules/readable-stream/readable-stream.example.ts -->
[**readable-stream.example.ts**](../examples/core-modules/readable-stream/readable-stream.example.ts)
```typescript
import {StreamingDataSource, Topic} from '@streamerson/core';

export const readChannel = new StreamingDataSource(/* optional options */);

await readChannel.connect();

for await (const event of readChannel.getReadStream({
    // ... optional options, like batch size and timeouts
    topic: new Topic('my-example-topic')
})) {
    readChannel.logger.info(event, 'Received event!')
    // Do something with my streamed event?
    // We could even `.pipe()` this event to a Writable.
}
```
<!-- END-CODE: ../examples/core-modules/readable-stream/readable-stream.example.ts -->

- And you're ... streaming with gas? Of course, this is relying on default connection settings and the existence of a
  Redis server. In this monorepo, there are tools for starting a Redis Docker image, and there are connection options
  built into the parameters of all the functions for connecting to a non-defaulted Redis instance.

## API

### RedisDataSource

- a base implementation of a data-source (any interface capable of)
    - **client** _(getter for a client for data connection)_
    - **control** _(getter for a client for orchestration)_
    - **connect()** _(connect to the datasource)_
    - **disconnect()** _(disconnect from the datasource)_

### StreamingDataSource

- an extension of the RedisDataSource, which implements streaming protocols:
    - **writeToStream({ ... })** _(write to a stream using the data-source)_
    - **getReadStream({ ... })** _(get a Readable for a stream)_
    - **getWriteStream({ ... })** _(get a Writable for a stream)_
    - **iterateStream({ ... })** _(get an Iterable that reads from a stream)_
    - **set()** _(set a key, for orchestration purposes)_
    - **get()** _(get a key, for orchestration purposes)_
    - *... and more*

### Promise Tracker

- a general purpose utility for using the `await` keyword to cede control until a future event has occurred on a stream.  You could generally use `.once('event')`, but due to memory management concerns I have exposed a utility with an interface as follows:
  - **tracker.promise('event')**
  - **tracker.cancel('event')**
  - **tracker.cancelAll()**

### Stream Awaiter

- a general purpose utility for call-and-response along two streams.  After a message with a given ID is dispatched to one stream, generate a promise that will resolve when the second stream receives a message with a matching ID, using the methods:
  - **streamAwaiter.dispatch('some-id')** _(a promise for a response with 'some-id')_
  - **streamAwaiter.readResponseStream()** _(begin reading incoming responses)_

### Utils

- A collection of utilities for internal Streamerson use.  Outside of that context, use them at your own peril:
  - ids
    - **guuid()** _(generate a GUUID)_
  - keys
    - **keyGenerator()** _(generate keys with standard markup for stream & key identifiers)_
    - **shardDecorator()** _(decorate IDs with a shard for logical partitioning)_
    - **consumerProducerDecorator()** _(decorate IDs with a consumer group for group partioning)_
  - stream configuration
    - **buildStreamConfiguration()** _(generate valid configurations for other builders)**
  - time
    - **MS_TO_SECONDS()** _(converts milliseconds to seconds)_
    - **SECONDS_TO_MS()** _(converts seconds to milliseconds)_ 
    - **HOURS_TO_MS()** _(converts hours to milliseconds)_
  - topic
    - **new Topic({ /\* options \*/ })** _(creates a Topic, which should probably be a first-class citizen of the core package but for now resides here)_

# API Reference
