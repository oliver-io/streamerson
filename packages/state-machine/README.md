# @streamerson/state-machine

> :warning: **WIP / unstable** :warning: — a distributed, recoverable application-state machine built on a Streamerson consumer group.

Part of the [`@streamerson`](../../README.md) monorepo. The idea: model application state as a **consumer group with a single writer and many readers** operating on a shared, recoverable in-memory state — aggregating a stream into an application layer that can serve and shard its current state. Think of it as a **Log-Structured Merge Tree for application state**.

## Status

Unfinished, and **excluded from the published release set**. It is the one package that deliberately uses **node-redis** rather than Bun's built-in Redis client, because it relies on Redis **client-side caching / client tracking** (RESP3 invalidation) that Bun's client does not yet surface. It still builds, tests, and runs under the Bun toolchain.

## Pieces

- **`StateCache`** — a typed facade over per-key state configurations (owner / replicated / rent), backed by `CacheableDataSource`.
- **`CacheableDataSource`** — a node-redis datasource with a local LRU cache and client-tracking invalidation, so reads are served locally and dropped when the underlying keys change.
- **`StreamStateMachine`** — drives the aggregated state from a consumer-group stream.

## Usage

Documentation incoming as the package stabilizes. See [Streamerson](https://github.com/oliver-io/streamerson).
