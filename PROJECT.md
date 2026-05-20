# PROJECT.md

Living **status & roadmap** for `@streamerson`. CLAUDE.md covers topology and how to drive the repo; this file covers **what actually works, what's broken, and what to do next.** It is intentionally blunt — working notes for finishing the framework.

> **Last reviewed:** 2026-05-20, against branch `reintegration-release` @ `8df9e61` ("old changes"), the newest pushed code. This tip is an admitted WIP dump, not a clean release.

## How we got here (branch lineage)

The framework was co-developed by dogfooding it against a real game (an RPG). Defects/refactors found during that integration drove most of the recent churn. Lineage, oldest → newest:

```
cluster-consumer (Nov'23, Piscina cluster on ioredis)
  └▶ cluster-consumer-linux (Jan'24, "nearly working clusters")
       └▶ cluster-consumer-linux-toreup (Jan'24, ioredis→node-redis, tore up cluster)
            └▶ game-reintegration (Sep'24, dogfooded against the game; merges main)
                 └▶ reintegration-release (Sep'24 → 8df9e61, "release emitter", docs)  ← current
```

Consequences of that history, visible in the tree today:
- **core switched from `ioredis` to `node-redis`** (the switch stuck).
- **`consumer-group` was folded into `consumer`** (group + member + config + cluster now live there).
- **`emitter` was extracted** as a standalone, published state library (from the game's client state needs).
- Package management is **mid-migration from Yarn to npm** (npm lockfile committed, scripts still say `yarn`).

## TL;DR

- **core** is the mature part and the streaming abstractions work for a **single-node** setup; the consumer-group path is wired correctly again.
- The remaining blockers to production use are operational: **no stream trimming** (unbounded Redis growth), **at-most-once delivery that contradicts the docs**, **no multi-instance response routing**, and a layer of **shipped debug cruft + unwired tests** that makes the published packages feel unfinished.

## Status by package

| Package | State | Summary |
|---|---|---|
| `core` | ✅ Functional, ⚠️ cruft | node-redis datasource, Topic/keys (now with `loopback()`), correlation. Works; carries debug logging and a stale protocol doc. |
| `consumer` | ✅ Functional | `StreamConsumer` + consumer groups (group wiring fixed) + Piscina cluster. Single-node solid; cluster still experimental. |
| `consumer` cluster | 🧪 Experimental | Piscina worker pool; lifecycle still undefined (Gap I). |
| `emitter` | ✅ Functional, published | Standalone `StateEmitter` (deep-path subscriptions). Independent of streaming. Most "finished" package. |
| `gateway-fastify` | ⚠️ Functional single-node | Awaiter dedup fixed; debug `console.log` noise; no multi-instance routing (Gap E). |
| `gateway-wss` | ✅ Functional single-node | Response stream now read via `topic.loopback()` (prior bug fixed); client routing by source token. |
| `state-machine` | 🚧 WIP | Now builds; excluded from `test`. README is a copy-paste of the wss README. |
| `examples` | ⚠️ Mixed | Real apps present; some imports/snippets may lag the `consumer-group`→`consumer` move. |
| `benchmarking` | ✅ Tooling works | Core overhead numbers exist; **end-to-end gateway numbers still N/A.** |
| `test-utils` | ✅ | Support lib. |

## Fixed since the prior review (against old `cluster-consumer`)

- ✅ **Consumer-group read wiring** — `ConsumerGroupMember` now threads `consumerGroupInstanceConfig` into the consumer, so members actually read as a group and `process()` no longer throws.
- ✅ **Gateway double-subscribe** — the Fastify plugin memoizes one awaiter per stream pair and starts the response reader once.
- ✅ **gateway-wss wrong stream** — responses are read from `topic.loopback()` (the producer end) instead of the request stream.

## Known gaps & bugs (blunt)

Severity: 🔴 blocks core promise · 🟠 serious · 🟡 cleanup. "Remediation" = whether the code already addresses it.

### 🔴 B. No stream trimming → unbounded Redis growth
`xAdd` uses `*` with no `MAXLEN`/`TRIM`; no `XTRIM` anywhere. Every request and response is appended forever → eventual Redis OOM for the intended workload.
**Fix:** capped/approximate trim on write (node-redis `xAdd(..., { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold } })`), configurable per topic; decide a retention story. **Remediation:** none.

### 🟠 C. At-most-once delivery, contradicting the docs
The group read uses `NOACK: true` (at-most-once: a crash mid-process loses in-flight messages). The acknowledged-read variant is now **fully commented out**, and `markProcessedByGroup` (`xAck`) is gated on `acknowledgeProcessed` but is a no-op against NOACK reads. READMEs still claim "guaranteed once-only delivery."
**Fix:** restore a non-NOACK read + `xAck` + PEL recovery, or commit to at-most-once and update the docs. Also: `markProcessedByGroup` checks `if (!ack)` on an un-awaited promise (always truthy) — the error path can't fire. **Remediation:** removed, not added.

### 🟠 E. No multi-instance response routing
All gateway instances read the same shared producer/response stream; correlation is by message id, so non-owning instances receive and discard others' responses. `sourceId`/`messageDestination` exist in the protocol to enable per-instance routing, but `sourceId` is never set (`decorateRequest('sourceId', '')`) and workers always write to the fixed producer key.
**Fix:** route responses to a per-source/per-instance stream using the protocol fields + `loopback()`. **Remediation:** anticipated by the protocol, not implemented.

### 🟠 D. Correlation timeout entries leak
`DeferralTracker.promise()`'s timeout rejects the pending promise but never deletes its map entry, and `dispatch` skips its `delete` when the await throws. Timed-out requests leak entries permanently (the response-before-deferral path self-cleans; the timeout path does not).
**Fix:** delete on timeout. **Remediation:** partial.

### 🟠 J. Shipped debug cruft in published packages
`core`/`consumer` ship with pervasive `console.*` logging (incl. profanity, e.g. in `DeferralTracker.promise` and `streamAwaiter`), large commented-out debug blocks (e.g. in `readAsGroup`), and a stray `}``` typo in `streamable`. These are in **published** packages (`@streamerson/consumer`, `@streamerson/emitter`, `private: false`).
**Fix:** strip debug logging; route through the logger at debug level; lint to forbid `console.*` in `src`. **Remediation:** none. *(Fast, high-credibility win.)*

### 🟠 K. Tests exist but aren't wired
Test files exist (core, consumer, gateways, emitter), but **no `project.json` defines a `test` target**, so `yarn test` (`nx run-many -t test`) exercises ~nothing. This is how regressions slip through (the old group-wiring break went unnoticed for ~2.5 years).
**Fix:** add `test` targets per package; make the consumer-group/group tests run in CI; ensure Redis is available for integration tests. **Remediation:** none.

### 🟡 G. `controllable` is globally force-disabled
The base datasource hard-disables the control connection ("DragonflyDB does not support CLIENT INFO"), and `abort()` is now fully commented out — so blocking reads can't be interrupted via the control channel, and the control client is dead code for all backends. (Also the control `createClient` is mis-constructed — passes host as `url` — but it's never created.)
**Fix:** make it backend-conditional, or commit to the Dragonfly constraint and document it. **Remediation:** present, but is itself the problem.

### 🟡 L. Protocol drift / docs stale
The wire format moved from positional packing to **named stream fields** (node-redis `xAdd` object form); `docs/PROTOCOL.md` still documents the positional scheme. Latent bug: `deserializeMessageObject` checks `messagePayloadFormat` but the writer sets `messageProtocol`, so its JSON-parse branch never runs (payload is re-parsed downstream, masking it).
**Fix:** update `PROTOCOL.md`; reconcile the field name; fix the wss/state-machine copy-pasted READMEs.

### 🟡 M. Build/dev-loop rough edges
Yarn↔npm limbo (lockfile vs scripts). `DEFAULT_BLOCKING_TIMEOUT` is **100ms**, so `iterateStream` polls Redis ~10×/s per reader — low abort latency, but constant chatter; pick this deliberately. `consumer` still lists an `ioredis` dep though core uses node-redis.
**Fix:** commit to one package manager; document/justify the poll interval; prune dead deps.

### 🧪 I. Cluster lifecycle is undefined
Piscina is a request/response task pool, but it hosts long-lived listeners: a worker's `connectAndListen()` resolves once the pipe is wired, so the task "completes" while the consumer runs detached. `min`/`processingTimeout`/`idleTimeout` are unused (only `max`), and the coordinator is itself a member with an empty `groupMemberId`.
**Fix:** define worker lifetime (block-for-life vs detached pool), wire the scaling knobs, separate coordinator from worker. **Remediation:** none.

## Roadmap (suggested order)

1. **Strip debug cruft (J)** and **wire test targets (K).** Cheap, and they restore credibility + a regression net before deeper changes.
2. **Add stream trimming (B).** Existential for the intended workload.
3. **Decide & plumb delivery semantics (C)** — at-most-once-and-say-so, or restore acked reads + recovery.
4. **Design multi-instance response routing (E)** using `sourceId`/`destination` + `loopback()`; fix the timeout leak (D) along the way.
5. **Resolve cluster lifecycle (I);** lift or document the `controllable` hack (G).
6. **Reconcile docs & dev loop (L, M)** and produce **end-to-end gateway benchmarks** to validate the overhead claim.

## Open decisions needed

- **Production broker: Redis or DragonflyDB?** Drives the trimming, control-connection, and `controllable` calculus.
- **Package manager: Yarn or npm?** Pick one; the split state is a footgun.
- **Is `emitter` a permanent first-class package** or a vendored extraction from the game? Affects whether it gets its own release/test rigor.
- **Cluster workers: detach-and-return, or block-for-life?** The load-bearing ambiguity in the Piscina design.
- **Stream retention: deliberate audit log (offloaded to tiering) or just not-done-yet?** Determines whether B is "add MAXLEN" or "add MAXLEN + an archival path."

## Updating this doc

Keep it current with reality, not aspiration. Reference files/symbols by name, not line numbers. When a gap closes, move it into the "Fixed since" section (or delete it), update the status table, and bump the review date + branch.
