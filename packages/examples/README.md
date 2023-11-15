# @streamerson/examples

> A set of examples and reference implementations for the @streamerson implementation / pattern

# Table of Contents:
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Recommended Path:](#recommended-path)
- [Core Modules / Library-level](#core-modules--library-level)
- [Higher-Level Modules / Framework-level](#higher-level-modules--framework-level)
- [Implementation Examples / Usage-level](#implementation-examples--usage-level)
- [Usage / Running Examples](#usage--running-examples)
- [Tests](#tests)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Recommended Path:

If you're popping in here and taking a look at this code, let me point you first toward the documentation for [Redis Streams](https://redis.io/docs/data-types/streams/), on top of which most of this is built as the underlying streaming mechanism.  That protocol is fairly low-level, but offers blocking-request functionality, which means that we can build primitive event-oriented structures on top of open connections to Redis (i.e., push-data to or between servers, event subscriptions, _et cetera_).

My implementation that turns these streams into abstractions usable in Typescript-land might be evident if you follow the following chain of source code:

Low Level:
- [Streamable Data Source](../core/src/datasource/streamable.ts): the lowest-level abstraction of a Streamable

Abstraction-Light:

- [A Bare-Bones Unidirectional Stream Consumer](./consumers/single-uni/consumer-without-framework.example.ts): consumed as an EventEmitter
- [A Bare-Bones Bidi Consumption Pattern](./consumers/single-bidi/consumer-without-framework.example.ts): read, process, & write via `.pipe` and `Transform`

Framework-level usage:

- [the Framework Consumer/Producer](./consumers/single-bidi/consumer-with-framework.example.ts): a simple interface to do bidi stream processing, hiding the complexity of the lower-level implementations above
- [the Framework Consumer-Group](./consumers/groups/consumer-group-readable.ts): a consumer which reads from the same stream as others, each getting independent messages that will be redelivered on failure (resembles Kafka Consumer Groups).  The ConsumerGroup implements the same unidirectional or bidirectional modes as the single group member

## Core Modules / Library-level

These examples show how the smallest, most modular pieces of the framework are assembled.  This explicitly leaves out higher-level constructs meant for interface-usability, meaning that you should judge the readability of this code with a gracious eye.  It really isn't meant for outside this project, although it could be used that way.

- #### [A ReadableStream from a Redis Stream](./core-modules/readable-stream/README.md)
- #### [A WritableStream from a Redis Stream](./core-modules/readable-stream/README.md)

## Higher-Level Modules / Framework-level

These examples build upon the `@streamerson/core` library, providing user-friendly interfaces for common use-cases.  They may be too use-case-specific for your particular niche, in which case the core modules might expose some pieces with assembly-required.  If not, enjoy:

- #### [A One-Way Consumer](./consumers/single-uni/README.md)
- #### [A Bidirectional Consumer/Producer](./consumers/single-bidi/README.md)
- #### [A Kafka-like Consumer/Producer Group](./consumers/groups/README.md)
- #### [Loading a Fastify Plugin to create a REST Gateway](./app-hello-world/streamerson-gateway.ts)
- #### [A Websocket Server to create a WSS Gateway](./app-websockets/streamerson-gateway.ts) 

## Implementation Examples / Usage-level

These examples are fully-functional out of the box, and show some assembled pieces from the framework-level abstractions in the monorepo.  The intention is to connect trivial examples in other frameworks ("hello-world", a typical CRUD app, etc) to this framework by example, hopefully demonstrating how the patterns are familiar.

- #### [A Hello World App](./app-hello-world/README.md)
- #### [A Typical CRUD App](./app-basic-crud/README.md)
- #### [A Websocket<->Stream Adapter](./app-websockets/README.md)

## Usage / Running Examples

Information incoming

## Tests

In a somewhat sneaky fashion, most of these examples either already or will eventually come with tests.  These tests will serve as sort-of integration tests, to be run to validate changes in the implementation, by being relevantly cross-cutting in the monorepo.  Also, the packages have more granular unit and integration tests, so feel free to have fun looking at mocks if you please.
