# @streamerson/consumer

> Typescript Consumer/Producer for Redis Streams

This package is a part of the larger [@streamerson](../../README.md) monorepo, which contain tools to interact with Redis streams in event-oriented architectures.  This particular member of the monorepo introduces a high-level interface for *consuming* and *producing* events/stream messages.  The idea is fundamentally to bind *handlers* to *events*, where the handler optionally *returns* a message to another stream.  This pattern is very similar to the `Request->Handler` trope we see in many webservers, and that's deliberate, to capture some of that functional style while working with streams.

# Table of Contents
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Installation](#installation)
- [Example](#example)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## A Foreword on Naming and Purpose
The reason this package is called `@streamerson/consumer` rather than `@streamerson/consumer-producer` is mulititude: brevity, clarity (does it produce consumers?), and moreover, in the `@streamerson` [architecture](../../README.md#high-level-architecture), consuming a stream very often means producing a message on another one, though that's not always the case-- i.e. this package supports multiple use-cases:

- Consume a stream message and do nothing (if there is no handler)
- Consume a stream message and do something (in a handler)
- Consume a stream message, do something, and produce a message on another stream

## Installation

- `yarn install @streamerson/consumer-group`

## Example

The following example will create a consumer reading from a Redis stream called `my-stream-topic`, and listening for messages with the `messageType: "my-event"`.  The example binds an event handler to `"my-event"`, the return value of which will be sent along the bidirectional channel to whoever may be listening:

<!-- BEGIN-CODE: ../examples/consumers/single-bidi/consumer-with-framework.example.ts -->
<!-- END-CODE: ../examples/consumers/groups/consumer-group-readable.ts -->

# Consumer-Producers

The `@streamerson/consumer` module is intended as an abstraction layer over the low-level components in the `@streamerson/core` modules.  The intention is to provide a feature-rich, usable layer for application-layer consumers of events.  I am going to keep mentioning that the feature-richness of the `@streamerson/consumer` is the reason for its existence (over just using the core modules), so let's take a look at some of those features:

## Features

- Hides the underlying Streams and EventEmitters behind functional interfaces
    - Allows access to these underlying constructs as an escape hatch
- Creates an "Event Type" -> "Event Handler" contract familiar to developers
- Supports dynamic switching of these event handlers
- Supports configurable `bidirectional` / `unidirectional` modes
- Supports message routing `(a->b->c->...->x)` modes for stream pipelines
- Supports consuming from multiple streams at once (fan-in multiple `Topics`)
- Remembers its streams so you don't have to reference them in operations
- Supports configuration for providing your own Redis client, logger, etc.


To understand the motivation for these features, first, let's look at a side-by-side of a low-level featureless consumer written for your benefit (dear Reader), and beside it, the `@streamerson/consumer` for comparison.

## Examples in Depth

<details>
    <summary>Drop Down to see Low-Level "Bidi Stream Processor" Example Code</summary>
<!-- BEGIN-CODE: ../examples/consumers/single-bidi/consumer-without-framework.example.ts -->
<!-- END-CODE: ../examples/consumers/single-bidi/consumer-without-framework.example.ts -->
</details>

You'll notice the code in the dropdown above is kind of grossly low-level (it is concerned with streams, Transforms, etc.) and requires assembly.  Luckily, the `@streamerson/consumer` comes with lots of features out of the box, and conceals the configuration burden behind reusable interfaces, and allows for a declarative approach to the more imperative components in the monorepo.  Let's take a look:

<details>
    <summary>Drop Down to see High-Level "@streamerson/consumer" Example Code</summary>
<!-- BEGIN-CODE: ../examples/consumers/single-bidi/consumer-without-framework.example.ts -->
<!-- END-CODE: ../examples/consumers/single-bidi/consumer-without-framework.example.ts -->
</details>

Hopefully this seems cleaner, less concerned with low-level details, and easier to understand from the perspective of someone doing service development.  The handler for each event resembles in principle the handler for a web-request, and is routed along a `MessageType` in much the same way that a web-request is routed by its `path`.  The metadata of the stream message is visible to the handler (much like the `Request` objects many developers know fondly) as is the payload of that message (again-- much like the `Body` of a `Request`).  This familiarity is intentional and why the `@streamerson/consumer` is the sort of "blessed-path" over utilizing the lower level modules (as in the case of the "low-level" example code above).

# API
<!-- BEGIN-CODE: ../consumer/src/_API.md -->
<!-- END-CODE: ../consumer/src/_API.md -->

## Message Acknowledgement / Tracking

The `@streamerson/consumer` does not support the acknowledgement of messages server-side-- i.e., the stream itself in Redis does not know who has read what, or who last read which message, and two `consumer` modules reading from the same key would get the same messages.  (If this is _disappointing_, please read on for some _appointment_)  This means that this module is appropriate for fan-in streams, event-broadcasting use-cases, etc.

So if you want to have a sort of once-only processing architecture (in which one or many readers each operate on different stream messages), this particular package is not it...  the [`@streamerson/consumer-group`](../consumer-group/README.md) package :star: **is** :star: though, so you're in luck!

If you found yourself in this section because you are wondering about _**acknowledgement**_, then you might be looking for a consumer-group of one member (or more), which "automagically" checks each message back in using the `XACK` Redis protocol, meaning that its consumer-group is message-processed aware.  `@streamerson/consumer` instances are stream-position aware using a cursor, but they do not acknowledge a message as "complete" in Redis.

(Footnote: it is possible to have multiple consumer groups, each with independent message-processed awareness over the same set of messages, resulting in exactly-twice [or N-times] processing per message.  I can think of only a few use-cases for this, but it's a cool idea.)

TLDR:
- This consumer deliberately does not mark a message "processed" -- after all, there could be other readers in a fanout or broadcast scenario.  This also makes the whole process faster.
- If you want a stateless, once-only delivery of messages to a single consumer that marks its messages as processed in Redis when complete, look at the [`@streamerson/consumer-group`](../consumer-group/README.md) package.

## Stream Recovery / Cursor Iteration

!warning! Some of the following may not be fully implemented but will be in a 1.0 version: !warning!

The default behavior of the `Consumer` is to come alive and listen only for new messages.  However, a `cursor` parameter allows the consumer to begin reading from a historical point in the stream.  This is automatically done as the client curses across stream entries from Redis, but can be supplied manually for a number of reasons.

If you want to implement recovery at the process-level such that a reader can die, come alive, and not miss any messages, with the `@streamerson/consumer` module, it requires some configuration logic.  This is by design, because these modules cannot know the identity of a reader on a stream, so storing its last position on the stream (statelessly) requires some bespoke value-- luckily, supported in configuration on the `recoveryKey` constructor parameter.

This key specifies at which key in Redis to store the iterators for a given client-- meaning that in a multi-reader scenario, to have per-reader recovery, you would want to give each of these readers a unique `recoveryKey` driven by environment or build configuration.

If this seems like a pain, it's potentially because you are crossing over the threshold from a `consumer` to a `consumer-group` when you begin caring about tracking the state of individual readers on a given stream.  Much of that process is handled out-of-the-box for us by Redis when we utilize the `consumer group` API, which is implemented in the [`@streamerson/consumer-group`](../consumer-group/README.md) module.  A richer explanation of this difference can be found [above](#message-acknowledgement--tracking).
