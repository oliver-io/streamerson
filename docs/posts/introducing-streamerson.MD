## *@streamerson* `(Preview)`:

> An upcoming Typescript framework for distributed application-data streaming in realtime (using native Node.JS streams)

*@streamerson* is a Typescript framework for orchestrating all kinds of real-time messaging and eventing patterns.  It uses the Redis protocol and the underlying `Streams` implementation to present a Node-idiomatic facade of objects that encapsulate the Redis stream data source.

Yes, that's right; with `@streamerson` building stateless event-oriented architectures looks like normal procedural code again!  What you stream is what you get; the required infrastructure is only one friendly package: open-source Redis or a compatible alternative.  Using this package you can:

- **Use stateless `ReadableStream** objects to access **serverside streams** under the hood, i.e.
  - I.e., subscribe to remote stream messages with typical syntax `stream.on('data', ...)`
  - Iterate over remote streams with typical syntax (`for await (const message of stream) { ... }`)
  - Pipe and transform remote streams with typical syntax (`inStream.pipe(transferStream).pipe(outStream)`)
- **Use stateless `WritableStream`** objects to write to the **remote streams**
  - (And use native Node.JS `.pipe()`, `Transfer`, `Duplex`, etc. -- sky's the limit)
- Use streams to model `fan-out`, `fan-in`, or `once-per` delivery patterns
- Orchestrate remote data channels with code instead of infrastructure
- Drop-in HTTP(s) and WebSocket gateways that emit `@streamerson` events
- Communicate in realtime between applications without HTTP(s) or WebSockets
- Dispense of your internal load-balancing by safely parallelizing processors with `Consumer Group` APIs
- And maybe most importantly, do all of the above with low-code interfaces that simply work.  The `@streamerson` project contains high-level abstractions to puppet the local representation of these streams for complex use-cases.

:warning: A foreward: this monorepo is *upcoming* because it is lacking rigorous testing (automated and otherwise), has some known defects, and is at a sub-1.0.0 version.  There are performance issues I would like to iron out, for which recent benchmarks have been written to gauge the improvement.  If the following content interests you, I'd very much appreciate any feedback to spur me onward toward my release goals.  :warning:


## Example: setup

Let's dive into three real examples.  Beforehand, these steps will be necessary:

1) Install the dependencies
```bash
npm install @streamerson/core @streamerson/consumer @streamerson/gateway-fastify
```

2) Start Redis
```bash
docker run -p 6379:6379 redis
```

## Example: trivially read

1) Create a file `reader.ts`:
```typescript
import { Topic, StreamableDataSource } from '@streamerson/core';

const myTopic = new Topic('my-stream');

const dataSource = new StreamableDataSource();

const stream = dataSource.getReadStream({ topic: myTopic });

stream.on('data', (event) => {
  console.log(event);
});

// When this excecutes, any stream messages will be consumed and logged.
// That said, there aren't any messages on this stream, so you won't see much.
// In the next example, let's write some data to a stream.
await stream.connect();
```

## Example: trivially `pipe()` & write

1) Create a file `writer.ts`:
```typescript
import { Topic, StreamableDataSource } from '@streamerson/core';
import fs from 'fs';

const myTopic = new Topic('my-stream');

const dataSource = new StreamableDataSource();

const inputStream = fs.createReadStream('./my-file.txt');
const outputStream = dataSource.getWriteStream({ topic: myTopic });

await outputStream.connect();

// All the file contents will be streamed to the remote stream (wrapped in a
// message envelope per chunk). If you ran this alongside the `trivially read`
// example, you would see the contents being read in realtime as it is written.
inputStream.pipe(outputStream);
```


## Example: an API on Streams

The above are trivial use-cases so let me give an example of something a bit more interesting.  If you follow steps 1-7 in a Typescript package of your choosing, you'll end up with a local API server which uses a stream and processor to do all its handler work.

1) create a file `processor.ts` which is the handler for `helloWorldEvent` messages:
```typescript
import {Topic} from '@streamerson/core';
import {StreamConsumer} from '@streamerson/consumer';

export const streamTopic = new Topic('my-stream-topic');

const consumer = new StreamConsumer({
    topic: streamTopic
});

consumer.registerStreamEvent('helloWorldEvent', async (event) => {
    consumer.logger.info(message, 'Read a stream message');
    return {
        ok: "received message!"
    }
});
```

2) create a file `server.ts` which will start a local HTTP server and listen for requests, sending them to be processed by the processor:
```typescript
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';

export const streamTopic = new Topic('my-stream-topic');

// Any normal fastify instance:
const apiServer = fastify({
    logger: true
});

// Create a plugin which directs the payload of requests
// through a bidirectional stream and listens for responses:
await apiServer.register(CreateGatewayPlugin({
    topic: streamTopic,
    routes: [
        {
            method: 'GET',
            url: '/',
            messageType: 'helloWorldEvent'
        }
    ]
}));

await apiServer.listen({
    port: 3000,
    host: 'localhost'
});
```

3) Start the processor
```bash
  tsx ./processor
```

4) Start the server
```bash
  tsx ./server
```

5) Open a web browser to `http://localhost:3000` or follow the link in the terminal output from step (6)


6) Observe the results!  The HTTP `GET:/` request to the Fastify API sent a message to a Redis stream which was received in realtime by the processor application.  When it responded (along the bidirectional channel) with its payload, the Fastify API sent that back to the requesting client, and the browser displays: `ok: "received message!"`.  If you were to look at the logs from `server.ts` and `processor.ts` you will see the broadcasting of those events in realtime.

### Example Notes

- The above example uses a `Fastify` gateway to produce messages.  We could just write them directly, but then you wouldn't get to use the browser to see the results and I wouldn't be able to show off the drop-in Fastify plugin.  In the real world, most use-cases would be between two headless applications without a frontend, but the demonstrated plugin allows traditional HTTP access to stream data.
- The above example has only one processor.  Using the `ConsumerGroup` API from `@streamerson`, we could scale its processors horizontally to whatever degree without losing performance from the orchestration.
- The above example has a single writer to its stream.  We could actually have many APIs behind a load-balancer, all writing messages to one stream, all of which fan out to a consumer-group with guaranteed once-only delivery per message (i.e., no two workers will ever get the same work).

## Do You Like What I am Putting Down?

If so, then I've got some excellent news.  Not only have I built up the above use-cases, but I've in fact abstracted upon them to build a few high-level tools to make event-oriented application-development with `@streamerson` even easier.

- `@streamerson/consumer`: bidirectionally communicate between applications with an express-like interface for binding events to handlers
- `@streamerson/gateway-fastify`: a drop-in Fastify plugin to translate HTTP to `@streamerson` messages
- `@streamerson/gateway-wss`: a uWebSockets gateway to translate realtime events to-and-from `@streamerson` messages

And some "eating of my own dogfood":
- `@streamerson/examples`: examples, demos, and use-cases to illustrate the above packages in motion
- `@streamerson/benchmarking`: a suite of benchmarks to evaluate my claims, your use-case, and general performance of these patterns-- maybe interesting even if you don't want to use my code

## Ok, cool, but what use-case?

If you find yourself feeling allergic to HTTP(s) microservices in the modern Cloud-native world, you might have considered building event-oriented applications on top of a number of services:

- AWS SNS/SQS
- AWS EventBridge
- AWS Kinesis
- GCP PubSub
- RabbitMQ (or other AMQP implementations)
- Kafka (offered in various managed flavors from AWS, Azure, and GCP)
- Redis (managed or otherwise), typically with a framework like `bull`
- Etc.

Often times, the eventual conclusion is that these applications are not well-suited for realtime applications (with the exception of Kafka, which is a mess to manage and expensive to run).  Batch and background processing, queued horizontal distribution of work, etc. are all excellently suited to almost all of the above-- but if you were endeavouring to publish millions of messages across your stack every minute, and all of these messages were ephemeral in nature (simply driving complex event flows), you might find yourself overpaying and under-provisioned.

Redis has historically offered highly competitive support for these patterns of realtime messaging, but has suffered from deployment issues of its own in the form of Cluster woes and Pub/Sub fanout congestion.  With the introduction of `Streams` in Redis 5.0, the Redis team has provided a new tool for developers to build realtime applications on top of Redis-- `@streamerson` is my attempt to publish a Typescript framework for doing so easily and idiomatically in Node.JS.

## So What Does `@streamerson` Do Here?

The deployment model of `@streamerson` lends itself well to both vertical horizontal scaling on the Cloud with the underlying protocol of communications modulated by the `Redis Streams Consumer Group` API.  Many horizontally scaled processors (or clusters of processors) can read from one-or-many streams, which means the processing power behind any stream is just a detail of its deployment that can be nigh-on-arbitrarily scaled; particularly when each domain of data (i.e., service) is isolated to a dedicated Redis instance.

`@streamerson` is naturally suited to a number of use-cases:
  - Application-to-application communications of almost any variety
  - Powering event-driven architectures of any kind, such as
    - Backends for web applications of any variety (GraphQL, REST, etc.)
    - Event sourcing
    - Notification platforms
    - Chat/data subscription applications
    - Multiplayer games

But it isn't just realtime, because there is no problem with utilizing the same organizational tactics in messaging to build background processes.  It makes sense to use `@streamerson` to power:
  - Analytics pipelines of almost any variety
  - Coordination of many worker threads or processes
  - Distributed computation and sorting
  - Etc.

## A note on the platform (Redis)

I'm currently experimenting with subbing `DragonflyDB` in as a replacement for `Redis`.  It has a drop-in replacement API and offers multicore utilization of cloud-based machines-- it's surprisingly difficult to get a single fast CPU with a ton of RAM.  If anyone's interested in this stay tuned.

## Further Reading

I can only include so much content here.  I've written a decent amount of documentation, so I'll leave a few links here:

- Github Monorepo and top-level documentation
- Examples
- Core Package
- Benchmarks

## Where does that leave us?

If this package is interesting to you, please drop me a comment here and ask whatever questions you have.  If it's offensive to you, do the same and we can start up an old-school flamewar like in the YCombinatiors and Usenets of Yore.

But honestly any feedback (negative or positive) will keep the fire stoked in me to continue this project.  Even if you'd only touch this project once it has between four and six logos and 3000 stars-- tell me so and it will give me some motivation.




