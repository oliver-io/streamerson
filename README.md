# @streamerson

> An API framework powered by distributed stream processing

:warning: **This project is in active development and is not yet trustable to be stable or work.  If you're interested in using it, hit me with a watch or star, and perhaps prod me toward publishing a 1.0.0 version.** :warning:

This is the root of the Streamerson monorepo, which is a collection meant to be assembled into various use cases for event-oriented streaming architectures (or just any Redis stream use-case).  The packages of interest are as follows:


# Monorepo Packages:

- `@streamerson/core` - [a collection of core low-level implementations and utilities](./packages/core/README.md)
- `@streamerson/consumer` - [an event consumer/producer for Redis streams](./packages/consumer/README.md)
- `@streamerson/consumer-group` - [kafkaesqe groups of consumer/producers with only-once delivery](./packages/consumer-group/README.md)
- `@streamerson/gateway-fastify` - [a Fastify plugin shifting RESTful traffic to stream consumers](./packages/gateway-fastify/README.md)
- `@streamerson/gateway-wss` - [a Websocket server shifting WSS traffic to stream consumers](./packages/gateway-wss/README.md)
- `@streamerson/state-machine` - :warning: **WIP/Unfinished:** :warning: [a distributed state(less)-machine made of a
  consumer group with a single writer](./packages/state-machine) and many readers operating on a shared, recoverable in-memory state. The idea is
  that it is easy to model state machines and transitions (and serve information about the current state) by aggregating
  a stream into a single application-layer that can recover & shard its state in Redis.  One could imagine this as a **Log-Structured Merge Tree for Application State**.


## Table of Contents:
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [High Level Goals](#high-level-goals)
- [High Level Architecture](#high-level-architecture)
- [Usage](#usage)
  - [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# High Level Goals

This project is my attempt to implement a pattern I probably didn't invent, but
will here claim. It is an API pattern/framework meant to simplify many of the
problems I see in modern microservice architecture. Roughly, it is meant to
achieve the following:

- **Separate REST** "handlers" from the code that they execute ("endpoints")
- **Stream all data** between backend services, never make HTTP/s calls
- Enable **per-"endpoint" scaling** decisions (without code churn)
- Allow for a **polyglot backend** without polyglot API frameworks
- **Reduce infrastructural complexity** by flattening data flow

# High Level Architecture

Three simple premises drive the architecture of the Streamerson pattern:

- A load-balanced, stateless REST API listens to all user traffic. Think of it
  as a gateway. It is normal, except extended with one new feature: the ability
  to connect to a source of streaming data, and when users make requests, it
  simply writes to the appropriate stream for that message. After doing so, it
  waits for a response message from the streaming data source that is specific
  to the originating request.

- One or more streaming data sources provide bidirectional streams to the API
  layer and a worker layer. In all examples in this documentation, you are to
  read this data source as being Redis Streams, but you could imagine them being
  any platform meant for streaming (Kafka, Kinesis, SQS, etc).

- A worker layer: any pool of compute reading from streams and maybe responding.
  This could be thought of as a bunch of worker threads, each apportioned to
  some stream (or set of streams), reading in the payloads of requests and
  executing some business logic. It maybe writes a response message to the
  appropriate stream.

That's it-- at a high level, this is the architecture I propose. My
implementation is just a set of stitched-together libs and wrappers, meant to
abstract away all the streaming logic and simply provide an interface to wrangle
these streams without worrying about the complexity.

# Usage

Installation and such instructions are soon coming. I'm in the middle of a refactor to this project at the moment and
this README is likely to shift around.

## License

This project is licensed with the LAMC (Love All My Cats) license. It is to be taken very seriously, but permits pretty
much unrestricted usage of this code.

If you use Streamerson, or are inspired by it, please drop me a star, comment, issue, PR, email, or well-wish.
