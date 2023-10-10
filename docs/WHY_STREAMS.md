# Welcome

You might have come here because I linked you to this document, or because you've followed it from my rambling documentation.  The purpose of the following diatribe is to answer a question that might naturally occur to you when presented with [the architecture](../README.md#high-level-architecture) I have suggested elsewhere.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [The Question](#the-question)
- [The HTTP(s) Dream](#the-https-dream)
- [The HTTP(s) Nightmare](#the-https-nightmare)
- [Why Bad Dreams?](#why-bad-dreams)
  - [**_Is that even possible?_**](#_is-that-even-possible_)
- [Yes](#yes)
- [Ok, so why are you talking about Redis a lot?](#ok-so-why-are-you-talking-about-redis-a-lot)
- [Realtime & The "Overhead" Discussion](#realtime--the-overhead-discussion)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->


# The Question

It might go something like this:

> Why would I use streams between an API and a microservice instead of HTTP?

If you are already thinking ahead or familiar with similar architecture, you might also ask:

> Aren't HTTP endpoints just streams of socket data?  Have you really invented anything?

Yes, and maybe, but in Typescript land, we like to deal with _high level abstractions._  So read on and I will explain why I have chosen this higher level abstraction pattern over those underlying HTTP streams.  

Also, go write a raw TCP server and come back to me asking these rude questions-- of course it's a stream but I'll mark it up however I please.


# The HTTP(s) Dream

At its root, every HTTP transaction is just a socket (a stream), transmitting a series of datas that begin and end with some special markup.  When that "ending" is reached, the underlying connection itself (the socket) can be closed (or not, depending on some special markup).

If we think about HTTP connections as streams (and we should), we can achieve a really low latency across this channel and we can even leave the connection open to do weird bidirectional stuff, like websockets.

The dream is alive-- the entire modern web is built on top of these socket connections, and everything we use is constantly negotiating their existence under the hood.  They are pretty cool.

# The HTTP(s) Nightmare

When we start dealing with webservices talking to webservices, if you've worked in a production environment, you know that the dream is not so fun to build at times.  The dream is not so fun to maintain.  The dream is not so fun to debug.  The dream is not so fun to scale.

Why?  Let me just list off a few trigger words for engineers:

- Load Balancer
- SSL Termination & Negotiation Overhead
- Reverse Proxy
- "Too Many Open File Descriptors"
- "Connection Reset By Peer"
- `Connection: "Keep-Alive"`

Need I go on?  Ok:
- 503 because Load Balancer talk to Dead Host
- 502 because Load Balancer talk too fast to Resurrected Host
- 500 because Load Balancer returned 503 to Other Service
- 429 because Load Balancer not talk to Correct Host

I could riff for a time on all the ways that I have seen servers fail to communicate, and the resulting thundering herd of various problems that are observable from the outside of this system.  I find it, at best, distasteful.

# Why Bad Dreams?

Many of the problems I've described above are resultant from one fundamental problem: data flows are **complicated**, **webservices interact in complicated** ways, and the multitude of produced streaming connections are **so complex it is difficult to even imagine the state of a typical prod environment.**

To anyone who balks at the above accusation, answer the following:

- Would it even be possible in a typical production system to know how many HTTPS  requests are currently in flight across the entire stack?  How about how many requests are in flight to a single service?

I say that the answer to the above is respectively a sound "no", and a soft "probably". We generally answer the second question ("how many web requests are in flight for the user-service right now?") by consulting an observability tool, which is informed by making more HTTP(s) requests from the service to some aggregator, ha ha ha...

Ok, so many-to-many streams at scale are hard to manage.  They're too interconnected, and when the level of complication increases, that interconnectedness begins to resemble a certain Italian dish that software developers malign.

So.  What if we decided we would have **one single aggregation point for all HTTPS** streams, and run a powerful server there that would hold all streams in memory, providing a single interface for consumers to subscribe, read, and publish to any stream?  Could consumers then freely connect & disconnect at will, making their problems no longer the problems of other applications-- unless they fall too behind on their stream?

## **_Is that even possible?_**

# Yes

That is just Redis.  Ok, it's also Kafka, or Kinesis, SQS, or EventBridge.  They all provide to us one central place to which we can make our piddly HTTP connections and-- after we've done so-- retrieve information about _their_ representation of a stable, persistent stream.  That stream can be marked processed, allowing consumers to "begin" and "end" processing certain chunks of data, and they allow bidirectional communication (you can both consume from a stream, and write to the same or another stream).  Some of those fellas even support complex abstractions over the top for retrying messages, sharding streams into logical partitions, and scaling the underlying processing of those stream messages.

# Ok, so why are you talking about Redis a lot?

We could conceive of Redis as a large pool of RAM with a few simple jobs:
1) wrangle streams (incoming & outgoing TCP connections)
2) feed & eat stream data (incoming & outgoing queries/mutations)
3) remember stream content for us (key-value storage & Redis Streams)

In this world, a Redis server is really just a remote aggregation point for TCP sockets that allows us to turn their ephemeral physical nature (the connections) into logical, observable entities (Streams).  When two webservers interact via streams, they leave an indelible trail of their logic, meaning that a failure can be recovered from or a success can be replayed.  It means that we also have a first-class citizen from which observability tools can read something that is only written once.  We can suddenly know things about our stack (like the approximate number of in-flight requests) by simply consulting the health of our streams.

This also means that we can now structure our *applications* logically.  A "service which updates user-profiles" is simply a function stream-processing from the same kind of object (a source of request events) that any other service is listening to (a source of events).  The work that they do can be in any language, and by talking in [a common protocol](../README.md#stream-message-protocol), no application is aware of the other's implementation.  _**We now no longer have to worry about anything but data contracts and their delivery.**_

In fewer words, to rehash words from another document:

- We can separate the runtime of API structures (REST servers, load balancers, etc) from the logic that they consume-- and build simple functional code which produces a common output (stream message) given some common input (... a stream message)-- where backpressure is buffered by the streaming implementation.


# Realtime & The "Overhead" Discussion

So you might at this point be saying:

> That's all fine and dandy, but we would have done this earlier if it didn't impose a ridiculous overhead on the microservice pattern by adding a whole layer of abstraction (not to mention RTT overhead when messages are going to and from the chosen [Redis] source of streaming). . .

I say, "dream".  No one is using Redis streams.  They're insanely fast.  I argue that the overhead is negligible given the reduced costs in various layers of compute.  I admit that there are certain fundamental issues which might make it wrong for some use cases, but I think the strategy has legs, and I'm willing to prove it.  In minimal amounts of testing, the framework-level overhead was similar to what you see in HTTPs servers between client and server (though obviously beaten by a bare Fastify server); the benefit is reaped in scaling and architectural simplicity anyway, not minimal RTTs.

I'm currently working on [benchmarking](../packages/benchmarking/README.md) the overhead of the pattern and abstractions in my modules, and I will provide the results in those linked docs.