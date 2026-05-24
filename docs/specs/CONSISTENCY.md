# Consistency Model

**Status:** spec (normative intent + current-implementation notes). Companion to [PROTOCOL.md](../PROTOCOL.md) and [WHY_STREAMS.md](../WHY_STREAMS.md); current gaps tracked in [PROJECT.md](../../PROJECT.md).

This document states **what guarantee the framework makes about data ordering, and what it deliberately delegates to the application.** It exists to stop two things from being conflated: the *consistency* of messages (an ordering property the framework owns) and the *reliability* of their delivery/persistence (a separate axis), and to stop the application's freedom to coprocess from being mistaken for a framework defect.

The framework implements **no application-consistency protocol of its own** — no transactions across application state, locks, fencing, leader election, or quorum (no `MULTI`/`EXEC`/`WATCH`, no `SETNX`/lock/fence). Every *ordering* guarantee below is inherited from **one single-threaded Redis node** plus **the total order of a single stream key**.

> **Delivery-reliability uses Lua and pending-entry recovery (since the receipt work).** The consumer-group layer now issues `EVAL`/`EVALSHA` for atomic terminal transitions (`{XADD response; XACK}` and `{XADD dead-letter; XACK}` — `core/datasource/streamable.ts › respondAndAck`/`deadLetterAndAck`) and `XAUTOCLAIM`/`XPENDING` for pending-entry recovery (the coordinator's reaper). These give **delivery** atomicity (record-and-ack can't split-brain) — they are *not* a cross-key *application*-consistency protocol, and the distinction this document draws is unchanged. See [REQUEST_STREAM_RECEIPT.md](./REQUEST_STREAM_RECEIPT.md).

## The split

There are two data substrates, and they get two different answers.

| Layer | What it is | Ordering guarantee |
|---|---|---|
| **Message log** (the streams) | `XADD` to a `Topic`'s consumer/producer keys; correlation by message id | **Linearizable, per stream key** — the framework owns this |
| **Application state** (consumers, `state-machine` cache, handlers) | Whatever a consumer computes from messages | **Application-defined** — undefined/coprocessed order is allowed by design |

The mental model is **log-is-truth** (as in event sourcing / Kafka): the stream is the ordered record; what consumers do with it is their business.

## Framework guarantee: messages are linearizable

A single Redis stream key, written via `StreamingDataSource.writeToStream` (`XADD … *`), receives **monotonically increasing ids** assigned by the single-threaded server in the real-time order it processes the appends. Reads (`blockingStreamBatchMap` → `XREAD`/`XREADGROUP`, decoded by `parseStreamReply`) observe entries in that id order. That is precisely the linearizable-log property:

- **Atomic unit:** one message = one `XADD`. It takes effect at a single instant.
- **Total order:** all appends to a given stream key are totally ordered, and that order respects real time (if append A returns before append B is issued, A's id precedes B's).
- **Single copy:** there is one node (`docker-compose.yaml`: a lone `redis:6.2-alpine`), so there is no replica to read a stale value from.

This is the guarantee callers may rely on: **the message you wrote is in the log, at a well-defined position, in one global order with every other message on that key.**

> A `Topic` spans **two** keys (consumer + producer; see PROTOCOL.md and `Topic.loopback()`). Each key is independently linearizable. The request→response *pair* is a composition of two linearizable appends correlated by `messageId` (`DeferralTracker`), and the framework does **not** present that pair as a single linearizable object — see "Application layer."

## Application layer: order is application-defined

Consumers and state are **application logic**, and the framework intentionally does not constrain their ordering — exactly as an HTTP server may receive R1 then R2 and commit their effects in either order by coprocessing. We do not call HTTP non-linearizable for that, and the same reasoning applies here.

- A **single consumer** processes its stream serially in arrival order: `StreamConsumer.connectAndListen` pipes through a `Transform` that calls `callback()` inside the handler's `.then`, so the next message is not pulled until the current handler resolves. This yields **sequential-per-consumer** processing — a property of that consumer, not a framework guarantee.
- A **consumer group / cluster** (`ConsumerGroupCluster`, Bun `Worker` threads) distributes entries across members via `'>'`; members run concurrently, so there is **no global processing order** across a group. This is expected.
- The **`state-machine` cache** (`CacheableDataSource`, with `owner`/`replicated`/`rent`) is the application choosing its *own* semantics over its *own* derived state: owner-local writes, fire-and-forget replication, TTL-bounded reads. Treat this as application-domain eventual consistency, **not** a framework consistency claim. (It is also where the strongest single-key guarantees are deliberately traded away for locality; if a handler needs an atomic counter it must use Redis `INCR` directly via `StreamingDataSource.incr`, not the owner-cache path, which increments in the local LRU.)

The framework's contract stops at the log. Reconstructing stronger guarantees on top (single-writer per entity, projections) is an application/design concern — see "Intended direction."

## Reliability ≠ consistency

Message linearizability is an **ordering** property. It is orthogonal to two other axes, and the phrase "messages are linearizable" must not be read as covering them:

- **Delivery.** The group read is now `XREADGROUP '>'` **without `NOACK`**, so every delivered entry enters the consumer's PEL. The default contract is **at-most-once *effect* with no silent loss**: each message reaches a terminal state — DONE (handler succeeded, acked) or FAILED (recorded in a per-topic dead-letter stream) — and an entry leaves the PEL only via an atomic terminal transition; an entry abandoned by a crashed member is swept to the DLQ by the coordinator's reaper (`XAUTOCLAIM`, idle ≥ `processingTimeout`). **Opt-in retry** (REQUEST_STREAM_RECEIPT.md §7) upgrades this to **at-least-once** (idempotent handlers required). A message can still be linearizably appended yet not produce its *external* effect exactly once — that is the irreducible delivery-vs-effect gap, delegated to idempotent handlers — but it is no longer *silently dropped*. (Closes PROJECT.md Gap C.)
- **Durability.** Persistence is RDB-only (`--save 20 1`); the linearizable tail can be lost in a crash window of up to ~20s. No AOF, no replica.

These do **not** contradict message linearizability — the log's order is intact regardless. They mean that for the strong end of the spectrum (atomic counters, anything payment-like), you need **ordering (have it) + reliability (Gap C + durable retention, not yet done)**. The two compose; neither substitutes for the other.

## The single-node asterisk

The linearizability above is **substrate-derived, not engineered.** It holds because there is exactly one single-threaded node. Put Redis behind a replica or Cluster and message linearizability degrades on failover — async replication can drop an un-replicated tail — and there is **no fencing or leader election in the code** to compensate. So the precise claim is: *linearizable on one node.* That is sufficient for the intended model; it is stated here so the dependency is explicit and is revisited if the broker topology changes (an open decision: Redis vs DragonflyDB — see PROJECT.md).

## Where the five models land

| Model | Framework's position |
|---|---|
| **Linearizability** | **Yes, per stream key, on a single node.** This is the framework's guarantee for *messages*. Direct `StreamingDataSource.incr` (Redis `INCR`) is a linearizable counter. Not engineered beyond the node — see asterisk. |
| **Serializability** | **Not a framework concern** for application state. There is now one narrow Lua boundary — the RPC terminal transition atomically spans the producer + consumer keys (`{XADD response; XACK request}`), so a response is durable iff its request is acked — but that is *delivery* atomicity, not application serializability. A general request lifecycle still has no transactional boundary; single-writer-per-entity remains an application-layer concern. |
| **Snapshot Isolation** | **Not applicable.** No MVCC/versioning/snapshots. The cache's stale local reads are not a consistent snapshot. |
| **Eventual consistency** | **The application/derived layer's posture, by design.** The `state-machine` cache converges via TTL; the planned reverse-streamer→SQL drain is an eventually-consistent materialization. Not the *log's* property. |
| **Causal consistency** | **Yes — subsumed by per-stream linearizability.** Causal is strictly weaker than linearizable, so any causal chain carried on a single stream key is preserved automatically, and the request→response chain holds *by construction* (a response is written only after its request is consumed, so it cannot be observed before its cause). What is **not** automatically tracked is causal order **across different stream keys** (no vector clocks / dependency metadata) — that sits in the same application-concern bucket as serializability/SI. Note: concurrent group members may *process* in-order-delivered messages out of order, but that is coprocessing, not message reordering. |

## Intended direction (inferred design target)

The architecture leans toward a **partitioned single-writer (actor-ish) model**: the `#shard` decorator (`shardDecorator`), `Topic`/`loopback()`, and the explicit ownership hand-off (`StreamStateMachine.transfer`, dispatching a `TRANSFER` message) point at *single-writer-per-entity, processed serially*. That is the lever that yields **linearizable-and-sequential per entity** without global serializability, SI, or consensus — the right target for this transport. Realizing it depends on closing the reliability/routing gaps:

- **Delivery semantics (Gap C):** **substantially done** — acked reads + PEL + reaper + DLQ + atomic Lua transitions give no-silent-loss (default at-most-once-effect); opt-in retry adds at-least-once, then idempotent handlers give effective exactly-once. See REQUEST_STREAM_RECEIPT.md.
- **Per-instance response routing (Gap E):** `sourceId`/`messageDestination` exist in the protocol for this but are not wired (`sourceId` is hardcoded empty; workers write a fixed producer key).
- **Durable retention (Gap B):** reverse-streamers draining to SQL before deletion; native `MAXLEN` trim is an opt-in backstop only.

This section is the one part marked **inferred** — it reads intent from the partitioning + transfer primitives, not from a prior design doc.

## References

- [PROTOCOL.md](../PROTOCOL.md) — wire format (named stream fields).
- [WHY_STREAMS.md](../WHY_STREAMS.md) — rationale for streams over interior HTTP.
- [PROJECT.md](../../PROJECT.md) — current gaps (B: retention, C: delivery, E: routing) and open decisions.
- Code: `core/datasource/streamable.ts` (`writeToStream`, `blockingStreamBatchMap`, `parseStreamReply`), `core/deferral/*` (correlation), `consumer/base/stream-consumer.ts` (per-consumer serial), `consumer/cluster.ts` (group concurrency), `state-machine/datasources/cacheable.ts` (application-domain cache).
