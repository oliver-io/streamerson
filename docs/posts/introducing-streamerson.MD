## A *@streamerson* Preview:

> An upcoming Typescript framework for (actually) real-time messaging

*@streamerson* is a Typescript monorepo containing a bunch of tools, both high-level and low, for orchestrating all kinds of real-time messaging patterns.  It uses the Redis protocol and the underlying `Streams` implementation to present a Node-idiomatic facade of objects that encapsulate the Redis stream data source.

:warning: A foreward: this monorepo is *upcoming* because it is lacking rigorous testing (automated and otherwise), has some known defects, and is at a sub-1.0.0 version.  There are performance issues I would like to iron out, for which recent benchmarks have been written to gauge the improvement.  If the following content interests you, I'd very much appreciate any feedback to spur me onward toward my release goals.  :warning:

If the above is too jargony, let me lay out the capacities of the core package (`@streamerson/core`):

- Read from remote, decentralized message streams with Node.JS `ReadableStream`
- Write to remote streams with normal `WritableStream` objects
- Subscribe to remote stream messages with typical syntax `stream.on('data', ...)`
- Iterate over remote streams with typical syntax (`for await (const message of stream) { ... }`)
- Pipe and transform remote streams with typical syntax (`inStream.pipe(transferStream).pipe(outStream)`)
- Other fun stuff with streams

## Sound interesting?

If so, then I've got some excellent news.  Not only have I built up the above use-cases, but I've in fact abstracted upon them to build a few high-level tools to make event-oriented application-development with `@streamerson` even easier.

- `@streamerson/consumer`: bidirectionally communicate between applications with an express-like interface for binding events to handlers
- `@streamerson/gateway-fastify`: a drop-in Fastify plugin to translate HTTP to `@streamerson` messages
- `@streamerson/gateway-wss`: a uWebSockets gateway to translate realtime events to-and-from `@streamerson` messages

And some "eating of my own dogfood":
- `@streamerson/examples`: examples, demos, and use-cases to illustrate the above packages in motion
- `@streamerson/benchmarking`: a suite of benchmarks to evaluate my claims, your use-case, and general performance of these patterns-- maybe interesting even if you don't want to use my code

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

## What Does It Do?

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




