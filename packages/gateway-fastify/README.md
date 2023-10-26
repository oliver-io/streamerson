# @streamerson/gateway-fastify

> A Fastify Plugin to create a Streamerson REST Gateway

This package supplies an out-of-the-box solution to accept incoming transactional requests over HTTP(s) and proxy them to Redis Streams, allowing for a [consumer](../consumer/README.md) to process them and respond.  This allows a transactional layer to users, the underside of which is fulfilled entirely by an event-oriented call-and-response pattern.

The original intention for this architecture is to truly lean into the concept of using Redis as "application-glue"-- and decouple the business logic layer from REST infrastructure.  If you want to read more about this motivation, there is [some documentation](../../docs/PARABLE.md).

That said, this package might be of interest to anyone that simply wants to accept HTTP(s) traffic, and write something to Redis Streams as a result of that incoming traffic, maybe awaiting an event as a response.  It can operate in a fire-and-forget mode (no "call-and-response", just the "call"), which allows this plugin to directly act as a RESTful producer-endpoint for an event stream.

# Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Installation](#installation)
- [Usage](#usage)
  - [More Documentation](#more-documentation)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Installation

- yarn: `yarn add @streamerson/gateway-fastify`
- npm: `npm install @streamerson/gateway-fastify`

# Usage

Create a Fastify Gateway proxying REST transactions to a Redis stream:

<!-- BEGIN-CODE: ../examples/app-hello-world/gateway.ts -->
[**gateway.ts**](../examples/app-hello-world/api.ts)
```typescript
import fastify from 'fastify';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import {Logger} from 'pino'
import {Topic, StreamersonLogger} from "@streamerson/core";

export enum Events {
    HELLO = 'hello'
}

export const streamTopic = new Topic('my-stream-topic');

const apiServer = fastify<any, any, any, Exclude<StreamersonLogger, typeof console>>({
    logger: true
});

const streamPlugin = CreateGatewayPlugin({
    logger: apiServer.log,
    topic: streamTopic,
    routes: {
        method: 'GET',
        url: '/',
        messageType: Events.HELLO,
        timeout: 1000
    }
});

await apiServer.register(streamPlugin);

const serverOptions = {
    port: 3000,
    host: '127.0.0.1'
};

await apiServer.listen(serverOptions);
```
<!-- END-CODE: ../examples/app-hello-world/gateway.ts -->

(See: [app-hello-world example](../examples/app-hello-world/README.md))).

This code will create a Fastify server and load a plugin (the architecture for which you can read [here in Fastify's documentation](https://fastify.dev/docs/latest/Reference/Plugins/)).  The plugin will create an isolated route for `POST::/hello-world`, which will ship the body of the web request through the stream and optionally wait for a call-and-response signal to deliver to the requester.

This allows a [consumer](../consumer/README.md) or [consumer-group](../consumer-group/README.md) to receive traffic and process it, while at no point does the HTTP layer know about any business-logic or do any CPU-constrained work beyond the parsing of incoming requests.

<details>
    <summary>Fastify Consumer Example </summary>

<!-- BEGIN-CODE: ../examples/app-hello-world/worker.ts -->
[**worker.ts**](../examples/app-hello-world/worker.ts)
```typescript
import {StreamConsumer} from '@streamerson/consumer';
import {Events, streamTopic} from "./api";

const consumer = new StreamConsumer({
    eventMap: {
        [Events.HELLO]: (e) => {
            return {
                world: 'I am a stream processor'
            };
        }
    },
    topic: streamTopic
});

await consumer.connectAndListen();
```
<!-- END-CODE: ../examples/app-hello-world/worker.ts -->
</details>

This plugin works normally with Fastify, and it means you could load it into any normal HTTP(s) server and begin mixing traffic between traditional endpoints and stream-fulfilled endpoints, and although that may be a bit antipatternous to the [`@streamerson` philosophy](../../README.md#high-level-architecture), it may be useful for your use-case.


## More Documentation
 
See: [@streamerson monorepo](https://github.com/oliver-io/streamerson)
