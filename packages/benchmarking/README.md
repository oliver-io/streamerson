# @streamerson/benchmarking

> Reference implementations, Put To the Test

# Table of Contents:

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Benchmarking](#benchmarking)
- [Benchmarking Results](#benchmarking-results)
  - [Local Docker](#local-docker)
- [:star: 11/4/2023 LOCAL BENCHMARKS :star](#star-1142023-local-benchmarks-star)
- [:star: 11/4/2023 GCP BENCHMARKS :star:](#star-1142023-gcp-benchmarks-star)
  - [AWS](#aws)
  - [Google Cloud Platform (GCP)](#google-cloud-platform-gcp)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Benchmarking

This repo will contain a few things meant to benchmark the performance of the @streamerson modules. The general
structure will be like this:

- Prepare several different implementations of the same thing, some with @streamerson modules in the mix
- Prepare several different _deployments_ of those same things
- Run a series of definitions using [`artillery`](https://artillery.io/) against the deployed images _from_ another deployed
  image
- Compare the results to their peers, strictly relatively.
- Generate some graphs. Use them to improve, and/or brag, and/or understand things.

Right now I'm thinking I will build a sort of general CLI tool that takes a given use-case ("crud app") and stands it up
in

- Local (for development and baseline definitions)
- AWS (on EC2 with Redis hosted on ElastiCache)
- GCP (on GCE with Redis hosted on Cloud Memorystore)
- Probably That's It for Now

I'll track the current results below

## Benchmarking Results

### Local Docker

These tests have thus far been run on my machine with:
- 32gb RAM
- 8-core 3.8ghz Intel i7
- Windoze
- Docker Desktop

## :star: 11/4/2023 LOCAL BENCHMARKS :star

Local results for benchmarks using Artillery locally:
- [small payloads against local fastify w/ microservice](https://oliver-io.github.io//streamerson/fastify-small-report.html)
- [small payloads against equivalent local streamerson](https://oliver-io.github.io//streamerson/streamerson-small-report.html)
- [large payloads against local fastify w/ microservice](https://oliver-io.github.io//streamerson/fastify-large-report.html)
- [large payloads against equivalent local streamerson](https://oliver-io.github.io//streamerson/streamerson-large-report.html)

## :star: 11/4/2023 GCP BENCHMARKS :star:
- [large payloads against fastify w/ microservice running on GCP](https://oliver-io.github.io//streamerson/large-fastify-report.html)
- [large payloads against equivalent streamerson running on GCP](https://oliver-io.github.io//streamerson/large-streamerson-report.html)


The table is presented with the following meanings:

 - `Test Name`: the name of the scenario, where
   - `bulk` is to mean "all at once"
   - `iterative` is to mean "one-by-one"
   - `client` is to mean a bare redis client with replicated logic for benchmarking purposes
   - `framework` is to mean a streamerson equivalent
 - `control`: the time in milliseconds (ms) for the bare client implementation
 - `experiment`: the time it takes in ms for a simple streamerson implementation doing a wrapper operation to read the same stream as the `control` case
 - `Base Overhead`: the percentage difference between `experiment` and `control`
 - `stream`: the time it takes in milliseconds using the `get[read/write]Stream` API
 - `Stream Overhead`: the percentage difference between `experiment` and `stream`
 - `iterative`: the time it takes in millseconds using the `iterateStream` API
 - `Iterator Overhead`: the percentage difference between `experiment` and `iterative`


| Test Case                                                                                                                                                                                                                                                                    |                **control** (ms)                 |               **experiment** (ms)               | Framework<br/>Overhead                            |
|:-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-----------------------------------------------:|:-----------------------------------------------:|---------------------------------------------------|
| *the name of the benchmarking case, where <br/> | *time in ms for the bare client implementation* | *time in ms for the streamerson implementation* | ~ [*pct overhead imposed by @streamerson logic*]% |

:warning: As of `10/23`, these numbers exist as a first-pass over the benchmarking.  I'm sure that they will reveal many improvements, which is part of the reason I'm gathering the data.  I suspect that some of these initial numbers reflect time spent in transforming the Redis messages into `MappedStreamEvent`s (and et cetera), and may be over-representing the framework overhead by leaving certain logic that the framework has out of the benchmarks.  However, I guess that's part of the point. :warning:

:warning: :warning: When I begin optimizing this code (haven't yet, although I've tried to keep it pretty close to the metal), I'll be shooting to keep the framework overhead at or under ~20%.  :warning: :warning:

[//]: # (<details>)

[//]: # (<summary>)

[//]: # (  Dropdown for Benchmarking Results)

[//]: # (</summary>)

<!-- BEGIN-CODE: ./_reports/summary.md -->
[**summary.md**](./_reports/summary.md)

| Test Case            | **control** (ms) | **experiment** (ms) | Framework Overhead |
| :------------------- | :--------------: | :-----------------: | ------------------ |
| write-1k-iterative   |       112        |         112         | ~ 0.0%             |
| write-1k-bulk        |        36        |         54          | ~ 33.3%            |
| read-1k-iterative    |       104        |         113         | ~ 8.0%             |
| read-1k-bulk         |        7         |          9          | ~ 22.2%            |
| write-100k-iterative |       8359       |        8654         | ~ 3.4%             |
| write-100k-bulk      |       1061       |        2268         | ~ 53.2%            |
| read-100k-iterative  |       8598       |        9407         | ~ 8.6%             |
| read-100k-bulk       |       413        |         451         | ~ 8.4%             |

<!-- END-CODE: ./_reports/summary.md -->

[//]: # (</details>)

### AWS

<details>
<summary>
  Dropdown for Benchmarking Results
</summary>

```
N/A
```

</details>


### Google Cloud Platform (GCP)


<details>
<summary>
  Dropdown for Benchmarking Results
</summary>

```pre
N/A
```

</details>

