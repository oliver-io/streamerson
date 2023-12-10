# streamerson-gateway-wss

> A WebSocket Redis Stream Gateway

This package provides an out-of-the-box solution for proxying traffic between users and consumers via WebSockets.  The server will provide an HTTP(s) endpoint from which it can `UPGRADE` to a websocket after authentication.  This allows for a direct event-driven flow between client and server.

# Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Installation](#installation)
- [Usage](#usage)
- [More Documentation](#more-documentation)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Installation

- yarn: `yarn add @streamerson/gateway-wss`
- npm: `npm install @streamerson/gateway-wss`

# Usage

Create a WSS Gateway proxying Websocket connections to a Redis stream:

<!-- BEGIN-CODE: ../examples/app-websockets/streamerson-gateway.ts -->
[**streamerson-gateway.ts**](../examples/app-websockets/streamerson-gateway.ts)
```typescript
import {WebSocketServer} from '@streamerson/gateway-wss';
import {Topic} from "@streamerson/core";

export enum Events {
    HELLO_EVENT = 'hello'
}

export const streamTopic = new Topic('my-stream-topic');

const wssServer = new WebSocketServer({
    port: 3000
});

await wssServer.streamRoute('/hello', Events.HELLO_EVENT, streamTopic, {
    authenticate: () => {
        return true;
    }
});

await wssServer.listen();
```
<!-- END-CODE: ../examples/app-websockets/streamerson-gateway.ts -->

(See: [app-websockets example](../examples/app-websockets/README.md))).

This server will create an instance of a websocket server (driven by `uWebSockets.js`), which will listen for incoming socket traffic and write it to a corresponding stream as a producer.  When an application listens on that stream (see: [Consumer](../consumer/README.md) or [Consumer Groups](../consumer-group/README.md)), the data will be transferred back to the websocket-server and written to the corresponding websocket for the originating user.

Essentially, this server acts as a proxy between a websocket client and a stream, allowing the client to send and receive messages to/from a consumer.

<details>
    <summary>Consumer Example Code</summary>

<!-- BEGIN-CODE: ../examples/app-websockets/worker.ts -->
[**worker.ts**](../examples/app-websockets/worker.ts)
```typescript
import {StreamConsumer} from '@streamerson/consumer';
import {Events, streamTopic} from "./streamerson-gateway";

const consumer = new StreamConsumer({
    eventMap: {
        [Events.HELLO_EVENT]: (e) => {
            return {
                world: 'I am a stream processor'
            };
        }
    },
    topic: streamTopic
});

await consumer.connectAndListen();

```
<!-- END-CODE: ../examples/app-websockets/worker.ts -->
</details>

# More Documentation

See: [@streamerson monorepo](https://github.com/oliver-io/streamerson)
