# PROJECT.md

Living **status & roadmap** for `@streamerson`. CLAUDE.md covers topology and how to drive the repo; this file covers **what actually works, what's broken, and what to do next.** It is intentionally blunt — working notes for finishing the framework.

> **Last reviewed:** 2026-07-31, against branch `main` @ `02038cc` (newest pushed). This tip folds in the large July integration push (`cc787e7`, the spec-pinned test suites + consumer/core correctness work) and the dependency modernization. Most of the gaps this doc used to track have since closed — see "Fixed since".

## How we got here (branch lineage)

The framework was co-developed by dogfooding it against a real game (an RPG). Defects/refactors found during that integration drove most of the churn. Lineage, oldest → newest:

```
cluster-consumer (Nov'23, Piscina cluster on ioredis)
  └▶ cluster-consumer-linux (Jan'24, "nearly working clusters")
       └▶ cluster-consumer-linux-toreup (Jan'24, ioredis→node-redis, tore up cluster)
            └▶ game-reintegration (Sep'24, dogfooded against the game; merges main)
                 └▶ reintegration-release (May'26, "release emitter", docs)
                      └▶ main (Jul'26 → 02038cc)  ← current canonical
```

`main` is now the canonical branch (past `reintegration-release`, which lags). Consequences of the history, still visible:
- **core is on `node-redis`'s successor** — it now runs on **Bun's native `RedisClient`** (raw `send()` for stream commands); `node-redis` survives only in `state-machine` (deliberately, for client-tracking invalidation) and `benchmarking`.
- **`consumer-group` was folded into `consumer`** (group + member + config + cluster live there).
- **`emitter` was extracted** as a standalone, published state library.
- **Toolchain fully migrated to Bun** (runtime + PM + test runner + workspaces); the Yarn↔npm limbo is gone.

## TL;DR

- **core** and **consumer** are the mature parts; the single-node and consumer-group paths work, are **acked (at-least-once) with PEL recovery + DLQ**, and are covered by spec-pinning integration suites against a live Redis.
- **state-machine** graduated from WIP to a **tested** package (68 pass / 1 skip against live Redis).
- The remaining blockers to production use are now a **shorter, sharper list**: the **reverse-streamer retention strategy** (the native trim backstop exists; the drain-to-SQL strategy does not), **no multi-instance response routing**, and a few **doc/config** loose ends. The "unwired tests / shipped debug cruft" era is over.

## Status by package

| Package | State | Summary |
|---|---|---|
| `core` | ✅ Functional | Bun-`RedisClient` datasource, `Topic`/keys (`loopback()`, `deadLetterKey()`), correlation (`streamAwaiter`/`DeferralTracker`) with self-healing reconnect. Opt-in `MAXLEN ~` trim backstop. Debug cruft removed. 100% line-coverage gate on the stream reader. |
| `consumer` | ✅ Functional | `StreamConsumer` + consumer groups (`ConsumerGroupCoordinator`/member) + Bun `Worker` cluster. Acked reads, atomic Lua terminal transitions, opt-in retry (self-PEL drain), reaper→DLQ sweep. Broad integration coverage. |
| `consumer` cluster | ✅ Functional | Bun `Worker` pool (block-for-life): fixed `count`, runtime `scale()`, restart-on-crash, graceful drain. Live-Redis round-trip test. |
| `emitter` | ✅ Functional, published | Standalone `StateEmitter` (deep-path subscriptions). Independent of streaming. |
| `gateway-fastify` | ✅ Functional single-node | Awaiter dedup + `onClose` teardown + self-healing response reader + register-time `messageType` validation + per-route timeout. Reviewed first-principles (`docs/todo/FASTIFY_GATEWAY_REVIEW.md`); open items are interface-defining and spec-gated. No multi-instance routing (Gap E). |
| `gateway-wss` | ✅ Functional single-node | `Bun.serve` WS (no native addon); responses read via `topic.loopback()`; client routing by source token. Integration suite (round-trip, routing edges, auth edges, shutdown, malformed frames). |
| `state-machine` | ✅ Tested, 🚧 pre-release | Builds and tested (68 pass / 1 skip, live Redis): consistency matrix, invalidation/activation, recovery/hydration, ownership. Deliberately on **node-redis v4** for RESP client-tracking (Bun's client doesn't surface invalidation pushes; v6 regresses it — see below). Still excluded from the published release set. |
| `examples` | ✅ Type-checked | `verify-examples` type-checks the embedded examples/apps clean. Runtime smoke-run against Redis not yet a gate. |
| `benchmarking` | ⚠️ Tooling, type-debt | Core-overhead numbers exist; **end-to-end gateway numbers still N/A.** Carries pre-existing strict-null type errors and noisy `console.*` (unpublished tooling, out of the default build). |
| `test-utils` | ✅ | Support lib. |

## Fixed since the prior review (May'26 → Jul'26)

- ✅ **Toolchain → Bun (MODERNIZE Step 1).** Runtime, package manager, test runner, workspaces all Bun; `tsx`/`ts-node` dropped; one lockfile (`bun.lock`). Closes Gap M's PM limbo.
- ✅ **Tests wired + running (was Gap K).** `bun test` exercises broad integration suites (core datasource/correlation, consumer group/cluster/retry/DLQ, gateways, emitter, state-machine). Spec-pinning "RED" tests document remaining known defects on purpose.
- ✅ **Delivery semantics → acked at-least-once (was Gap C).** The group read no longer uses `NOACK`; entries stay in the consumer PEL until `xAck` (`markProcessedByGroup`), with reaper→DLQ sweep and opt-in retry (self-PEL drain, poison→DLQ). Atomic Lua terminal transitions. *(READMEs claiming "once-only" should still be reconciled to "at-least-once with dedupe-at-worker" — doc task.)*
- ✅ **Correlation timeout leak (was Gap D / GW8).** `dispatch` wraps write+await in `try/finally { delete(id) }` and `DeferralTracker.delete` clears the armed timer — the entry and its timer are released on every outcome.
- ✅ **Gateway response-reader robustness (GW5/GW6/GW9/GW14/GW15).** `onClose` teardown (no connection leak), self-healing reconnect with freeze + cursor-resume, register-time `messageType` validation, honored per-route timeout. Spec: `docs/specs/GATEWAY_READER_SELF_HEAL.md`.
- ✅ **`controllable` is now a real option (was Gap G).** `true/false` per datasource config; `abort()` is live (interrupts a blocking read via the control channel). No longer globally force-disabled.
- ✅ **Debug cruft stripped (was Gap J).** `core`/`consumer`/`gateway-*` `src` no longer ship stray `console.*` (only the logger). *(Remnant: a few `console.error(err)` in `state-machine/cacheable.ts`; benchmarking tooling is still noisy but unpublished.)*
- ✅ **Protocol field mismatch fixed (part of Gap L).** Reader and writer both use `messageProtocol` (the old `messagePayloadFormat`/`messageProtocol` split that dead-ended the JSON-parse branch is gone). *(Remaining L: `docs/PROTOCOL.md` still documents the old positional packing — doc task.)*
- ✅ **Native trim backstop (part of Gap B).** `StreamingDataSource` writes `XADD … MAXLEN ~ <maxLen>` when `options.maxLen > 0` — opt-in, off by default. *(This is the backstop, not the retention strategy — see B below.)*
- ✅ **Cluster lifecycle (was Gap I).** Piscina → native Bun `Worker` (block-for-life): admin-only coordinator, fixed member `count`, runtime `scale(n)`, restart-on-crash (bounded backoff), graceful drain. `processingTimeout`/`idleTimeout` wired.
- ✅ **Dependency modernization.** Audit-driven purge of unused deps + upgrades to modern (fastify 5, pino 10, lru-cache 11, uuid 14, eslint 10 flat config, TypeScript 6.0.3); missing internal/runtime deps declared; `workspace:*` linking. Zero test regressions vs baseline.

## Known gaps & bugs (blunt)

Severity: 🔴 blocks core promise · 🟠 serious · 🟡 cleanup.

### 🔴 B. No retention strategy → unbounded Redis growth (backstop only)
The opt-in native `MAXLEN ~` trim now exists, but it is a **lossy backstop**, not retention. Without a durable drain, every request/response is appended forever → eventual Redis OOM for the intended workload.
**Plan (decided):** **reverse-streamers** — processors that drain a stream from the tail and persist to SQL before deletion (never delete unflushed data); non-persisting drainers may flip on the native-trim backstop. **Remediation:** backstop done; the reverse-streamer design itself is unbuilt (needs a spec — ordering, SQL schema, persistence guarantees).

### 🟠 E. No multi-instance response routing
All gateway instances read the same shared producer/response stream; correlation is by message id, so non-owning instances receive and discard others' responses. The protocol carries `sourceId`/`messageDestination` to enable per-instance routing, but `sourceId` is still `decorateRequest('sourceId', '')` (never populated) and workers always write to the fixed producer key.
**Fix:** route responses to a per-source/per-instance stream using the protocol fields + `loopback()`. **Remediation:** anticipated by the protocol, not implemented. *(Ties to GW13 — the vestigial `sourceId`.)*

### 🟠 gateway-fastify review — interface-defining open items
`docs/todo/FASTIFY_GATEWAY_REVIEW.md` catalogs the remaining findings. The robustness/lifecycle set (GW5/6/8/9/14/15) is fixed; **open and spec-gated:** request fidelity (**GW1** — only `request.body` is forwarded), fire-and-forget mode (**GW2**), the worker-error/no-content response envelope (**GW3/GW7**), Redis auth/TLS config (**GW4**), and hygiene (**GW10/GW12/GW13**). None should be coded before agreeing the spec (CLAUDE.md).

### 🟡 L(residual). `docs/PROTOCOL.md` stale
The wire format moved to **named stream fields**; `docs/PROTOCOL.md` still documents the old positional packing. The code-level field mismatch it warned about is already fixed. **Fix:** rewrite `PROTOCOL.md` against `core`.

### 🟡 J(residual). `state-machine` `console.error` remnants
`cacheable.ts` still has a handful of `console.error(err)` before re-throw. **Fix:** route through the logger; add the `no-console`-in-`src` lint rule now that eslint is wired.

### 🟡 N. `benchmarking` type-debt + missing e2e numbers
`benchmarking` carries pre-existing strict-null type errors and is out of the default build; end-to-end gateway benchmark numbers are still N/A. **Fix:** clean the tooling's types; produce e2e gateway overhead numbers to validate the framework's core claim.

### 🟡 M(residual). Poll cadence
`DEFAULT_BLOCKING_TIMEOUT` is **100ms**, so a blocking reader re-issues its read ~10×/s — low abort latency, constant chatter. Deliberate, but document/justify it.

## Roadmap (suggested order)

1. **Reconcile docs to reality (L residual, C's README claims, `state-machine` README already done).** Cheap; the code is ahead of the prose now.
2. **Design the reverse-streamer retention (B).** Existential for the intended workload; needs a spec first.
3. **Design multi-instance response routing (E)** using `sourceId`/`destination` + `loopback()`; retires GW13.
4. **Work the gateway-fastify interface items (GW1–GW4, GW2, GW3/GW7)** — each needs a short design note before code.
5. **Produce end-to-end gateway benchmarks (N)** to validate the overhead claim; clean benchmarking's type-debt.
6. Strip the `state-machine` `console.error` remnants (J residual) and add the `no-console` lint rule.

## Open decisions needed

- **Production broker: Redis or DragonflyDB?** Drives the trimming, control-connection, and client-tracking calculus (state-machine relies on RESP client tracking).
- **`state-machine` on node-redis: stay on v4, or migrate to v6?** v6 regresses the client-tracking invalidation in the runtime context (reproduced; the suite is green on v4, which the code targets). A v6 migration is a separate spec-first task.
- **Delivery-doc reconciliation:** the code is acked at-least-once; the "guaranteed once-only" README language needs to become "at-least-once + idempotent worker." Confirm the messaging.
- **Reverse-streamer design (B):** ordering, SQL schema, persistence guarantees, and whether the native-`MAXLEN` backstop should ever default on for non-persisting drainers.
- **`docgen` TSDoc scope:** keep generating/embedding `_API.md` (via `tsdoc-markdown`), or drop that step from the pipeline (MODERNIZE 2.1)?
- **Is `emitter` a permanent first-class package** or a vendored extraction? Affects its release/test rigor.
- ~~Package manager~~ **Decided: Bun.** ~~Cluster workers~~ **Decided: block-for-life** (native Bun `Worker`; fixed `count` + runtime `scale()`).

## Updating this doc

Keep it current with reality, not aspiration. Reference files/symbols by name, not line numbers. When a gap closes, move it into "Fixed since" (or delete it), update the status table, and bump the review date + branch.
