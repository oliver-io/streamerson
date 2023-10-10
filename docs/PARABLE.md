<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [An Argument / Parable](#an-argument--parable)
  - [The Premise](#the-premise)
  - [The Dilemma](#the-dilemma)
    - [The `posts` Service](#the-posts-service)
      - [A problem arises](#a-problem-arises)
      - [A Typical Solution](#a-typical-solution)
      - [A Poison Pill?](#a-poison-pill)
    - [Streamerson Style](#streamerson-style)
      - [Enter Streamerson, Stage Left](#enter-streamerson-stage-left)
    - [Implicit Efficiency Gains](#implicit-efficiency-gains)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# An Argument / Parable

The following is a parable about a typical microservice and how the proposed
patterns of Streamerson might alleviate those problems. It's mostly aimed at
folks in the AWS/Typescript world, but should be understandable by anyone
working in modern high-availability, high-throughput web services.

## The Premise

Like hairbrained frameworks? Do you stan Redis Streams? More importantly, ever
ask yourself any of the following questions?

- _Why am I calling my own microservice via HTTP? Doesn't that mean I am opening
  a ton of sockets? What even is a socket, anyway?_
- _Why am I bootstrapping the same REST API in ten identical horizontally scaled
  images? Why am I using a REST API at all? What even is REST?_
- _How do you scale a REST API? Can I scale, like, an Endpoint? What even is
  scaling, anyway?_

If so, _congratulations_! :sparkles: You might be in the correct GitHub repo to be
further confused by another solution to these multitudinous questions. So buckle
up, if you'd like to read further-- I'll try to offer some rationale for why I
decided to solve this problem myself rather than use whatever code currently is
costing you thousands of dollars per month in AWS. :smile:

## The Dilemma

Let's say we take an industry standard API architecture with three RESTful
microservices running in ECS or the equivalent:

- `users`
- `posts`
- `comments`

Each of these services has a REST API, and each of these services has a
database. Each of the REST APIs is stateless, horizontally scalable, and has a
load balancer.

- The `users` service is a RESTFul API that allows users to do things like
  authenticate, control their own metadata, and see the data for other users
  (for example, to see a given user's profile picture).
- The `posts` service is a RESTFul API that allows users to do things like
  create posts, delete posts, and see posts from other users.
- The `comments` service is a RESTFul API that allows users to do things like
  create comments, delete comments, and see comments from other users.

Each service is backed by one database cluster (or some kind of
database-as-a-service).

Let's take a deep dive into what the `posts` service does.

### The `posts` Service

A load balancer is directing traffic to a cluster of 3 docker images running in
something like ECS. Each of these services is listening to traffic at endpoints
like the following:

- `GET /posts` _(returns a list of posts)_
- `GET /posts/:id` _(returns a single post)_
- `POST /posts` _(creates a new post)_
- `POST /posts/image` _(uploads an image)_

#### A problem arises

As a developer with an operational burden, let's say that we're seeing response
times from the `posts` service steadily growing. We're not sure why, but we're
seeing a lot of traffic to the `/posts` endpoint.

We decide to scale up the `posts` service by adding more instances of the
service. We do this by adding more instances of the service to our load
balancer. Let's say we add two, and the architecture now looks like this:

```pre
-> User Traffic
    --> Load Balancer
            ?|--> instance 1 <---> DB/S3
            ?|--> instance 2 <---> DB/S3
            ?|--> instance 3 <---> DB/S3
            ?|--> instance 4 <---> DB/S3
            ?|--> instance 5 <---> DB/S3
<--- User ---|
```

One of the five instances will randomly (or fairly) receive the request, process
it, and respond. However, we do not observe an acceptable decrease in response
times. We take a deeper look at the events actually being processed, and find
that the distribution is something like this:

- 50% of requests are to `/posts/image`
- 45% of requests are to `/posts/:id`
- 5% of requests are to `/posts`

We look at some metrics (observability is of course implemented in our stack)
and see the following:

- [`91.6%` of the total] `/posts/image` requests are taking 1000ms to process
- [`8.3%` of the total] `/posts` requests are taking 50ms to process
- [`0.1%` of the total]`/posts:id` requests are taking 10ms to process

We take a look at the code, and see that the single thread of the `posts`
service is spending 95% of its time encoding and decoding images when they are
normalized into S3. This operation is CPU-bound, and we're coming up against the
limitations of that single thread.

#### A Typical Solution

In the dev shop, we decide to scale up the `posts` service even further
temporarily, and we create a JIRA ticket:

- **[DEV-1234]**: Split `posts` service into `posts` and `images` services

and the team gets to work. We create a new service, `images`, and we move the
`/posts/image` endpoint to that service. When we productionalize that work, we
observe the response times of the `posts` service return to acceptable levels or
better. We see that the average time to `POST::/NEW-SERVICE/posts/image` is
still 1000 MS, but we can now scale the `images` service independently of the
`posts` service. We can also scale the `posts` service independently of the
`images` service.

#### A Poison Pill?

We've solved the problem! Cool?

No, not really.

We have now solved an operational problem ("the posts service is slow") with the
solution: "move some function into its own runtime".

The cost to achieve that?

- A new codebase
- A new deployment pipeline
- New infrastructure to manage and scale
- Probably more infrastructural cost (new load balancers, etc)
- Probably more images running in total, and higher costs
- Probably new packages to publish and version-manage (logic and types shared
  between `posts` and `images` services)
- A new architecture diagram
- New documentation
- New tests
- New monitoring
- New alerts from your new monitoring
- **And the worst, perhaps: - Duplicated code** (all REST server code, all
  middleware logic like authentication, etc)

100% of the work involved with the above migration is done to achieve the
above-stated goal: "Separate the runtime environment of two (or more)
functions". _Do you see where I might be going with my critique?_

Worse yet, there are actually a ton of implications that are not simply "higher
complexity". For example, we may have doubled-or-more our open connections to
the database shared by these services, if they share one. We may have lost out
on caches, or had to distribute caches-- and by doing so, increased the burden
on other services we may internally utilize for session authentication,
authorization, observability, etc. This "lift and shift" of code from the
`posts` service to the `images` service suddenly has become re-architecture, but
is presented as an additive change.

### Streamerson Style

What if we could separate all our REST APIs into one horizontally scalable
cluster, and what if the traffic from that REST API was streamed by fanout to
clusters of compute? Those clusters could be mutually handling the load of more
than one stream (for example, `/posts` and `/posts/:id` logic), or they could be
directed toward the work of a single stream (like in our rearchitecture,
`/posts/image` endpoints).

Scaling this architecture gets us back to our stated goal: **_shift around the
compute that is doing some work._**

You might say that this is a hard pattern, or that there are existing solutions.
An astute observer might ask: _"Aren't you suggesting we implement
`AWS APIGateway`? It hosts one RESTful API, and generally invokes a lambda for
each restful event, allowing a fanout of compute to individual runtime
environments."_

Well, _observer_, you can't be too astute if you want to pay for API Gateway.
:smile: Okay, I'm kidding, and APIGateway isn't super expensive, so it's a
viable solution to the problem. However, if you want to commit to lambda
architecture, this writeup may not be for you. Maybe should have mentioned that
earlier. I'm not against lambdas, but I have the following objections:

- APIGateway is hard to extend. You need to use more lambdas in a chain.
- APIGateway is hard to control. Certain features (like timeouts) are not
  configurable.
- Lambdas are not possible in all languages.
- Lambdas can be expensive.
- Lambdas split traffic into many individual runtimes, even if you would rather
  not.

And most importantly, I'm not writing this article to sell you a canned
solution. I'm writing this article to describe a pattern that we can fully
control, that I have implemented, and that you could use. The only dependency is
an application capable of streaming data to a TCP socket, in theory, but I will
be using Redis Streams, because they are hot. _Hot AF_. :fire: Not all
applications would be best served by Redis Streams here, as Redis is certainly
harder to scale than a solution like Kafka or Kinesis. Redis, however, is
another application we can almost fully control, and lets us make low-level
decisions about streaming.

#### Enter Streamerson, Stage Left

```pre
-> User Traffic
    --> Load Balancer
        --> API Cluster
            -----> Stream Out (generatedId = writeToStream(determineStream(message), message))
             |<--- Stream In (response = readFromStream(determineStream(message), generatedId))
<--- User ---|

...

-> API Stream Traffic
    --> Worker Layer
        ----> Determination (function = determineFunction(message))
        |<--- Execution (response = function(message))
<--API--|
```

By wrapping some rather simple (ok, dirty) code around a Redis client and some
promise logic, we can achieve the above flow with mostly framework-level code
and deployment logic. In theory, the business logic of any given application
would not really change at all. Instead, you would move a normal REST API into
the cluster-layer, which would handle traffic for many different domains of
logic. Then, you would shift the business logic of your application into the
worker layer, and decide its need for infrastructure and code-sharing. If you
wanted some cluster of functions (endpoints?) processed by a single
horizontally-scalable cluster, you would simply designate a set of functions to
them, and we would publish messages for all of those functions to one stream. If
you wanted to scale a single function (endpoint?), you would dedicate some
cluster of compute to just that stream. You could, in theory, use something like
Kubernetes to arbitrarily shift around the worker allocation such that some set
of functions could "borrow" compute from the others during spikes that affected
only it.

### Implicit Efficiency Gains

It isn't just a reduction in scaling complexity that we've achieved though--
we've actually cut cruft from the actual architecture. Consider the following
example that picks specifically on connection overhead as an example:

- In our **old world**, if a `posts` request is made, and its receiving API
  needed to contact the `user` service (perhaps to embed a profile picture), in
  traditional architecture we would invoke an HTTP/s call to the `user`
  microservice.

This means we would have to open a new connection (or configure
connection-reuse) to the `user` microservice, which might do the same to other services. That might mean an HTTP/s
handshake, potentially network costs depending on the cloud model, etc.

- In our **new world**, we would simply publish a message to the `user` stream,
  and the `user` worker would respond.

At no point did we create any request overhead or pending network connections.
Writing to the outgoing stream is easy and fast, and waiting for a message on
some incoming stream *doesn't require us to open new connections-- **we were
already listening.***

Similarly, the logic of authentication and any kind of higher-level middleware
can be executed on our API gateway and shared between many applications
implicitly. This means that we can _**cut all that code out**_ of our services.
Our services can now be made from almost pure logic, wrapped with some code to
handle streaming, and they become easier to maintain.
