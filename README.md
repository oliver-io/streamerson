# streamerson

> An API framework powered by distributed stream processing

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

Installation and such instructions are soon coming.  I'm in the middle of a refactor to this project at the moment and this README is likely to shift around.

## License

This project is licensed with the LAMC (Love All My Cats) license.  It is to be taken very seriously, but permits pretty much unrestricted usage of this code.

If you use Streamerson, or are inspired by it, please drop me a star, comment, issue, PR, email, or well-wish.
