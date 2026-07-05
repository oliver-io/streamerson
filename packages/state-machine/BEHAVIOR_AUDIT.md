# State-machine behavior audit

> **STATUS (2026-07-05): FIX PHASE COMPLETE.** Every Category-2 defect and every
> decided Category-3 contract below is implemented and green: the state-machine
> suite is **68 pass / 0 fail / 1 documented skip**. Fixes landed per the resolved
> decisions (TEST_PLAN.md §6) in five clusters: invalidation/activation (2.1/2.2/
> 2.3/3.4/D12), consumer/core layer (A8 double-shard, 2.13 wrapHandlers, A9 arming
> race — also flipped core's three pre-existing bug-#3 pins green), cache semantics
> (2.10 single-flight, 2.11 setHash algebra), recovery/delete/D13 (lazy hydration,
> owner write-through, value-convergent replication, full D-Delete, per-key ttl,
> config purge), and wire/D14 (real enum wire values, working transfer dispatch,
> derived-key precondition, NX ownership claim). Notable contract reading: owner-only
> state now write-through replicates (the `replicated` flag differs only in
> replica-serving intent) — required for SPEC(2.5) crash recovery.
> **Still deferred:** the D-Transfer receive side (durable-ack/rollback protocol);
> TTL-lease claim liveness (crashed owner leaves a stale D14 claim); an
> invalidationChannel reconnect (redirect target id changes); quietLogger honoring
> and the runtime MessageType index export (both upstream in consumer/core).
> The item texts below are preserved as the historical record of the defects.

Audit of `@streamerson/state-machine` against its intended model, prior to writing the
spec-capturing test suite. **No code has been changed**; every claim below is backed by a
file/symbol citation and marked with its evidence level:

- **[code-verified]** — the code path was read end-to-end and its behavior follows
  necessarily from the source (including cross-package contracts in `core`/`consumer`).
- **[inferred]** — follows from the code with high confidence but depends on runtime
  behavior of a dependency (flagged where a smoke test should confirm first).
- **[unevidenced]** — nothing in the repo (code, test, or doc) demonstrates it either way.

## The intended model (spec, as agreed)

The streaming data-retrieval model is not performant enough to serve reads at scale, but
introducing direct transactions would corrupt the streaming model. So instead: define an
**always-consistent node** that acts as a **ticker-tape reader of its stream** — a
`StreamConsumer` whose handlers mutate state only through a state layer. That node is the
**authoritative root mutator** for the state it owns. It holds state **locally,
write-through to Redis**, such that it can **recover state from the database** after a
crash. Other clients may act as **read-replicas** fed by Redis client-side caching
(client tracking + invalidation pushes), served from a local LRU. The primary use case is
**one state machine per service**, not distributed state — but the replica mechanism
should permit it.

The code expresses this in three layers:

| Layer | File | Role |
|---|---|---|
| `StreamStateMachine` | `src/stream-state-machine.ts` | The ticker-tape node: extends `StreamConsumer`, injects a `StateTransformerMap` into every handler so all mutation flows through the state layer. |
| `StateCache` | `src/state-cache.ts` | Typed facade: routes each state key's ops through its per-key `StateConfiguration`. |
| `CacheableDataSource` | `src/datasources/cacheable.ts` | The consistency model, keyed off three flags: `owner` (authoritative local mutator), `replicated` (write-through to Redis, serve replicas), `rent` (non-owning read-replica). Deliberately node-redis (not Bun's client) because it needs RESP invalidation pushes. |

---

## Category 1 — Stated behavior we believe works

> "Works" here means **code-path verified**: read end-to-end and consistent with the
> intent, with any cross-package contract checked at the source. **None of it is
> test-verified** — the package has zero tests — and item 1.0 gates everything else.

### 1.0 ⚠ Gate: the package may not construct at all

Before anything in this category can be trusted at runtime, one open question must be
settled (see 2.9): `new LRUCache({ ttl })` with lru-cache v7 likely **throws in the
`CacheableDataSource` constructor**. If it does, every item below is dead-on-arrival at
runtime despite being logically sound. **The very first test is a construction smoke
test.**

### 1.1 Ticker-tape wiring: handlers receive the state layer, not raw Redis
**[code-verified]** `StreamStateMachine` extends `StreamConsumer` and overrides
`_handle_message` (`stream-state-machine.ts:159`) so that a registered handler is invoked
as `handler(this.stateTransformers, payload, { sourceId })` and its return value is
wrapped as a `resp`-typed response message. This is the core "state machine as stream
reader" shape: the message pump, consumer-key derivation, and response write-back are all
inherited from the (separately tested) consumer base; only the handler calling convention
changes. The base `process()` still guards on unknown message types
(`consumer/src/base/stream-consumer.ts:211`).

### 1.2 Per-key configuration routing
**[code-verified]** `StateCache` correctly threads each operation to
`CacheableDataSource` with the matching `StateConfiguration`
(`state-cache.ts:45-85`), and `StreamStateMachine.getStateTransformers`
(`stream-state-machine.ts:59`) builds one `StateTransformer` per configured state key,
honoring an optional `dataKey(propertyTarget, context)` function to derive the cache key.
Key derivation composes `cacheComposite` (base consumer: prefixes topic/shard context)
with `shardDecorator`, so owner and replica agree on physical key names.

### 1.3 Owner write path: local-first, async replication, no invalidation loopback
**[code-verified]** For `owner: true` state, `set`/`incr`/`decr`/`setHash` mutate the
local LRU synchronously and return the local result immediately
(`cacheable.ts:44-49, 161-164, 199-203`). When `replicated: true`, the write is pushed to
Redis **fire-and-forget** on `cachedChannel` — deliberately the connection whose
invalidations would be redirected, so the owner never invalidates its own cache from its
own writes (the `// Channel where we don't receive LOOP invalidation` comments,
`cacheable.ts:58, 172, 211`). This is the correct write-through *shape* for a root
mutator: local state is authoritative, Redis is the durability copy, replication latency
never blocks the hot path. (Its failure/recovery semantics are Category 2 — see 2.5–2.7.)

### 1.4 Renter write path: awaited remote write
**[code-verified]** For `rent: true` (non-owner) state, scalar `set`/`incr`/`decr`
**await** the remote Redis operation on `this.client` (`cacheable.ts:63-66, 178-181`) —
a renter's write is durable before its promise resolves, and the renter defers to Redis
as the source of truth on its next read. Correct posture for a non-authoritative node.
(The accompanying local-invalidate call is broken — 2.3 — and `setHash` deviates — 2.11.)

### 1.5 Read-through caching, single-reader happy path
**[code-verified]** For `replicated || rent` state, `get`/`getHash` serve from the local
LRU when present, else fetch from Redis on `cachedChannel` and populate the cache;
`null`/missing results clear the cache entry (`cacheable.ts:84-146`). Sequential (non-
concurrent) reads behave correctly. (The concurrent case is broken — 2.10.)

### 1.6 Lifecycle: three-client connect/disconnect choreography
**[code-verified]** `connectAndListen` runs the consumer's stream listen and
`StateCache.connect` concurrently (`stream-state-machine.ts:187`); `StateCache.connect`
connects `cachedChannel` + `invalidationChannel` and subscribes to
`__redis__:invalidate` before connecting the main client (`state-cache.ts:35`,
`cacheable.ts:229-237`); `disconnect` unsubscribes and quits all three
(`cacheable.ts:239-246`). The choreography for the three node-redis clients is sound.
(The transfer channel's two extra datasources are leaked — 2.13.)

### 1.7 Payload unwrapping for stringified messages
**[code-verified]** The `registerStreamEvent` override unwraps single- and
double-stringified JSON payloads before invoking the handler
(`stream-state-machine.ts:146-156`), compensating for a known upstream
double-serialization inconsistency. It works; it is also a smell to keep visible
(the fix belongs upstream, not here — noted so tests pin current behavior, not
endorse it).

---

## Category 2 — Stated behavior we believe is broken, or have no evidence for

> Each item names the intended behavior, the defect, and the shape of the test that
> should capture the spec (expected to land RED against current code).

### 2.1 Read-replica invalidation is never enabled — the mechanism is inert
**Intent:** replicas hold an LRU kept fresh by Redis client tracking: reads on
`cachedChannel` register interest, and Redis pushes invalidations (redirected to
`invalidationChannel`'s subscription) when keys change.
**Defect [code-verified]:** `enableCache(id)` (`cacheable.ts:261`) is the only place
`CLIENT TRACKING ... REDIRECT` is issued, and **nothing in the repository calls it**
(grep across all packages: zero call sites). It also requires the invalidation channel's
client ID, which is never fetched anywhere. Consequently the `__redis__:invalidate`
subscription receives no messages, ever, and replica staleness is bounded only by the
600s LRU TTL.
**Test:** owner writes key K; renter (with tracking manually enabled the way the code
*should* do it) must observe the new value on next read. Against current code: renter
serves the stale LRU value for up to 600s.

### 2.2 The invalidation handler is wrong even if tracking were enabled
**Intent:** on an invalidation push, delete the named key from the local LRU.
**Defect [code-verified]:** node-redis subscribe callbacks are `(message, channel)`.
`invalidateCache` (`cacheable.ts:248-257`) reads `args[1]` as the key to delete — that is
the **channel name** (`__redis__:invalidate`), not the invalidated key. The actual key
(in `args[0]`) is only logged. So even with tracking on, no cache entry is ever evicted
(except, uselessly, one literally named `__redis__:invalidate`).
**Test:** deliver a synthetic invalidation for key K; assert `cache.has(K)` becomes
false. Fails.

### 2.3 Renter self-invalidation is a no-op
**Intent:** when a renter writes, it should drop its own cached copy so the next read
re-fetches the (now newer) remote value.
**Defect [code-verified]:** the write paths call `this.invalidateCache(null, cacheKey)`
(`cacheable.ts:52, 167, 205`), but the handler's `if (args[0])` guard makes any call with
a `null` first argument **do nothing**. A renter that writes K and then reads K gets its
own stale pre-write LRU entry.
**Test:** renter caches K=1 via get; renter sets K=2; renter gets K → must be 2.
Currently returns 1.

### 2.4 `transfer()` throws unconditionally — and would hang even if it didn't
**Intent:** hand ownership of a piece of state to another shard by dispatching it over a
dedicated transfer stream and awaiting acknowledgment.
**Defect [code-verified]:** three independent failures stack:
1. `transferChannel.dispatch(json, 'TRANSFER', shardTarget, 'transfer')`
   (`stream-state-machine.ts:109`) passes positionally as `(message, messageType,
   messageSourceId, shard)` — no `outgoingStream` was configured on the awaiter and no
   `outgoingStreamOverride` is supplied, so `dispatch` **throws**
   `'Either a configured or override stream target must be provided'`
   (`core/src/deferral/stream-awaiter.ts:58-63`).
2. The transfer channel's two `StreamingDataSource`s are constructed but never
   `connect()`ed (`stream-state-machine.ts:37-50`).
3. `readResponseStream()` is never armed on the transfer awaiter, so even a successful
   dispatch would wait for a response that can never be delivered, until deferral
   timeout.
**Test:** owner holds K locally; call `transfer(K, shardB)`. Expected per spec: message
lands on the transfer stream. Currently: synchronous throw.

### 2.5 Owner-only state is memory-only and silently expires — not recoverable
**Intent:** the root mutator owns state "in a write-through fashion such that it can
recover it from the database."
**Defect [code-verified]:** with `owner: true, replicated: false`, state lives **only**
in the LRU, whose entries carry a 600s TTL (`cacheable.ts:30`). It never touches Redis
(`cacheable.ts:44-49` — `dispatchRemote` stays false). Worse, `incrOrDecr` defaults a
missing entry to `'0'` (`cacheable.ts:45`), so an owned counter that sits idle past the
TTL **silently resets to zero on the next increment**. Write-through recoverability
currently exists only under `owner && replicated`, and nothing in the naming or types
says so.
**Test:** owner-only counter incremented to N; advance/expire TTL; incr again → spec
says N+1, current code says 1. (Also pins the crash-loss case.)

### 2.6 No hydration/recovery path exists, even for replicated state
**Intent:** after a crash, the owner recovers its state from Redis.
**Defect [code-verified]:** no code anywhere reads owned keys back from Redis into the
LRU — not at construction, not in `connect`, not lazily on the owner path (`incr`/`set`
for owners never consult Redis: `cacheable.ts:44-49, 161-164`). A restarted owner starts
cold; its first `incr` on a replicated counter treats local as `'0'` → sets local to 1
while fire-and-forgetting `INCR` on the true remote value. **Local and remote then
disagree permanently**, because the owner never reads back.
**Test:** owner increments replicated K to 5; new owner instance (same keys) increments
→ spec says local=6 and remote=6; current code says local=1, remote=6.

### 2.7 Fire-and-forget replication has no reconciliation
**Intent:** write-through means Redis eventually holds every owner write.
**Defect [code-verified]:** replication failures are caught and logged, then dropped
(`cacheable.ts:59, 174, 213` — `.then(() => {}).catch(log)`). No retry, no queue, no
dirty flag, no read-back. Any transient Redis failure silently degrades the durability
copy, and combined with 2.6 there is no repair mechanism at any later point.
**Evidence level:** the omission is code-verified; whether this is an accepted tradeoff
or a gap is a **spec decision to make before writing the test** (recommendation: at
minimum the invariant "after Redis recovers and one more write, remote == local" should
hold; today it does not for `INCR` since deltas, not values, are replicated).

### 2.8 Wrong wire values for TRANSFER/BROADCAST message types
**Intent:** transfer and broadcast messages are typed with the protocol's
`MessageType.TRANSFER` / `MessageType.BROADCAST`.
**Defect [code-verified]:** the code casts the enum **names**: `'TRANSFER' as
MessageType.TRANSFER` (`stream-state-machine.ts:109`) and `'BROADCAST' as
MessageType.BROADCAST` (`stream-state-machine.ts:118`). The actual wire values are
`'xfer'` and `'xcast'` (`core/src/types.ts:11,16`). Any consumer dispatching on real
enum values (`streamEvents[event.messageType]`) will never match these messages.
**Test:** capture the written stream entry; assert `messageType === 'xcast'` for a
broadcast. Currently `'BROADCAST'`.

### 2.9 Suspected constructor crash: LRU cache options
**Intent:** `CacheableDataSource` constructs an LRU with a 10-minute TTL.
**Defect [inferred — verify first]:** lru-cache v7 (`package.json` pins `^7.18.3`)
throws `TypeError` unless at least one of `max`, `maxSize`, or `ttlAutopurge` is set;
`new LRUCache({ ttl })` (`cacheable.ts:30`) sets none. Additionally `import * as
LRUCache from 'lru-cache'` (`cacheable.ts:1`) imports a namespace where v7 exports the
class itself — `new` on it may fail depending on Bun's CJS interop. This is the **gate
test** (1.0): construct a `CacheableDataSource` and assert it doesn't throw.

### 2.10 Concurrent-read sentinel leak
**Intent:** read-through caching is transparent to callers.
**Defect [code-verified]:** `get`/`getHash` write the literal string
`'caching in progress'` into the LRU before awaiting the remote fetch
(`cacheable.ts:96, 128`). A second read of the same key arriving in that window finds
`cache.has() === true` and **returns the sentinel string as the value** (for `getHash`,
where a `Record` is expected). The sentinel is also never cleaned up on fetch failure.
**Test:** two concurrent `get(K)` with a slow remote; both must resolve to the real
value. Currently the second resolves to `'caching in progress'`.

### 2.11 `setHash` deviates from the scalar consistency rules
**Intent:** hash state obeys the same owner/replicated/rent algebra as scalars.
**Defects [code-verified]** (`cacheable.ts:191-227`):
- The dispatch branch tests `owner || replicated` where scalar `set` tests `owner` —
  a non-owner `rent && replicated` writer takes the owner's fire-and-forget path instead
  of the renter's awaited path.
- `Object.assign(hashCurrent, hashRecord)` mutates the cached object **in place** —
  aliasing between the LRU entry and caller-held references.
- `Object.entries(assignedRecord).flat()` stringifies nested values to
  `'[object Object]'` on the wire.
- Because the locally **merged** record is what's flattened and `hSet`, a stale local
  merge base can resurrect deleted fields remotely.
**Test:** matrix test of `setHash` against the scalar rules per flag combination, plus a
nested-value round-trip.

### 2.12 `transfer` precondition consults only the local LRU
**Intent:** an owner can transfer any state it authoritatively owns.
**Defect [code-verified]:** the guard is `this.stateCache.has(...)`
(`stream-state-machine.ts:104`) → `cache.has(options.key)` (`cacheable.ts:34-36`), which
checks only the in-memory LRU — and note it checks the **raw** `options.key`, not the
`shardDecorator`-derived key the write paths use, so it can miss even locally-held
sharded state. Owned state that TTL'd out of cache but is durable in Redis cannot be
transferred: `throw new Error('State ... is not locally held')`.
**Test:** owner with replicated K present in Redis but evicted locally; `transfer` must
succeed per spec. Currently throws.

### 2.13 Handler-contract fork and lifecycle leaks
**Defects [code-verified]:**
- `streamEvents` is typed `(e: MappedStreamEvent) => ...` in the base
  (`consumer/src/base/stream-consumer.ts:71`) but the state machine invokes entries as
  `(state, payload, meta)` (`stream-state-machine.ts:161-167`). Handlers registered via
  the constructor's `eventMap` (registered by the **base** constructor with the base
  signature expectation) get the state-machine convention; any generic code that walks
  `streamEvents` and calls with one argument — e.g. the cluster's `wrapHandlers`
  (`consumer/src/cluster-member.ts:46-52`) — would invoke state-machine handlers with
  the event in the `state` position.
- `disconnect()` (`stream-state-machine.ts:180`) never disconnects the transfer
  channel's two `StreamingDataSource`s — a straight resource leak once 2.4 is fixed and
  they actually connect.
**Test:** (a) type/contract pin — a handler registered via `eventMap` receives
`stateTransformers` as arg 1; (b) post-`disconnect`, no open Redis connections remain.

---

## Category 3 — Behavior spoken of but not implemented at all

> Nothing to break here: the code either stubs, ignores, or omits these entirely. Tests
> for this category are **spec-capture tests written RED by design**, or deferred until
> the spec conversation happens (marked accordingly).

### 3.1 The transfer protocol's receive side
`transfer.txt` sketches the ownership-handoff protocol (pend inbound messages during
transfer, mark the shard pending, release when the new owner is live) — and its final
step is literally `4) ???`. There is **no listener anywhere** on the
`::incoming_state_transfer` stream the dispatch side targets
(`stream-state-machine.ts:46-49`); no handler ingests transferred state into a receiving
machine's cache; no pending/release choreography exists. The transfer feature is
one half of a wire with nothing on the other end. **Spec decision required before
testing beyond the dispatch-side pin in 2.4.**

### 3.2 Recovery/hydration (the other half of write-through)
"Recover it from the database" is stated intent with **zero implementing code** (2.6
documents the resulting divergence bug; this entry records the missing feature itself).
There is no startup hydration, no lazy owner read-through, no cache-warm API. The design
question — hydrate eagerly at `connect`, lazily on first owner access, or via an explicit
`recover()` — is open. **Spec decision required; the 2.6 test pins the current wrongness
either way.**

### 3.3 Delete semantics
`StateCache.set(type, key, null)` carries a `// TODO: handle null case as delete`
(`state-cache.ts:75`); `CacheableDataSource.del` is a stub returning `false` under
`// TODO: finish me` (`cacheable.ts:148-151`). `types.ts` has the whole delete surface
commented out (`del`, `delHash`, `delHashEntry` — `types.ts:8, 11-12`). Setting a hash
field to `null` via the string form produces `{ [key]: null }` handed to `hSet`. Deletion
does not exist in any form.

### 3.4 Replica activation orchestration
Beyond the broken handler (2.2), the *wiring* that would make a read-replica real was
never written: nothing fetches `invalidationChannel`'s client ID, nothing calls
`enableCache(id)` during `connect`, nothing re-enables tracking after a reconnect. The
node-redis choice, the redirect design, and the comment trail
(`cacheable.ts:8-15, 259-260`) all show this was the plan; the plan stops at the
one method nobody calls.

### 3.5 Dead configuration surface
`StateConfiguration` declares `local`, `refresh`, and `ttl` (`types.ts:34-36`) — none is
read anywhere. Every transformer method accepts a `useShard = true` parameter that is
never consulted (`stream-state-machine.ts:74, 81, 88, 95`). `CacheableDataSource.localStore`
(`cacheable.ts:21`) is written by nothing and read by nothing. Per-key TTL (as opposed to
the global 600s) is therefore pure fiction. Tests should not encode these until they're
either implemented or deleted.

### 3.6 Read-replica *distribution* story
The stated theory — "sharing read-replicas via the client-cache update mechanism for
non-owning clients" — has its Redis-side half sketched (3.4) but no application-side
story at all: no way for a second `StreamStateMachine` to declare itself a replica of
another's state configuration, no ownership assertion or conflict detection (two
machines can both claim `owner: true` for the same keys and silently diverge), and no
replica-side read API distinct from the renter write path. Consistent with "main use
case is state-machine-per-service"; recorded so the theoretical capability isn't
mistaken for an implemented one.

---

## Addenda — findings from the test-implementation phase (2026-07-03/04)

Discovered while building and running the suites (TEST_PLAN.md); each is empirically
verified against live Redis under bun 1.3.14 unless marked suspected.

- **A1 — silent no-op writes.** `{owner:false, rent:false}` configs never set
  `dispatchRemote`; every write resolves successfully while writing nowhere
  (`cacheable.ts` write paths). Pinned in `consistency-matrix.test.ts`.
- **A2 — owner-only `get` blindness.** `get` consults the LRU only when
  `replicated || rent`; owner-only `set` populates the LRU but `get` bypasses it and
  reads never-written Redis → `null` for state the owner just wrote. Pinned.
- **A3 — Bun class-field clobber (FIXED during this phase, approved).** The
  declaration-only `override streamEvents` field was emitted with define semantics by
  Bun, wiping the base's `{}` to `undefined` after `super()` — no handler could ever be
  registered (`registerStreamEvent` threw; `eventMap` registrations silently erased);
  the entire ticker-tape loop was dead under Bun despite being code-verified sound.
  Fixed with `declare` (`stream-state-machine.ts`). Same Bun-port family as A4.
- **A4 — construction crash (FIXED during this phase, approved).** `import * as
  LRUCache` was not constructible under Bun (`Module is not a constructor`), with the
  `{ttl}`-only lru-cache options rejection latent behind it. Fixed:
  default import + `ttlAutopurge: true` (`cacheable.ts`). This was audit 2.9, with the
  primary/secondary hypotheses inverted.
- **A5 — 2.11 nested-hash corruption is worse than recorded.** Nested values do not
  ship as `'[object Object]'`: node-redis rejects the non-string `hSet` argument and
  the fire-and-forget catch swallows it — the ENTIRE hash write (flat siblings
  included) silently drops while `setHash` resolves `true` and the local cache keeps
  the nested object. Three-way divergence for the field-null case (local
  present-with-null / remote survives / caller told true). Pinned with an AUDIT
  CORRECTION note in the matrix suite.
- **A6 — defect cancellation.** 2.3 read-your-writes is accidentally correct for
  `setHash` only: the 2.11 in-place aliasing overwrites the stale LRU entry. Fixing
  aliasing without fixing invalidation flips it RED (annotated in the test).
- **A7 — lifecycle hangs.** `disconnect()` on a never-connected machine/StateCache
  hangs forever, and a second `disconnect()` after a successful one also hangs
  (node-redis queues `unsubscribe`/`quit` on closed clients without settling —
  `state-cache.ts` → `endCacheListener`). The test harness works around it
  (`safeCloseDatasource`); the product defect stands.
- **A8 — sharded consumers are deaf (consumer/core layer, NOT state-machine).**
  `stream-consumer.ts:96-99` passes the already-shard-decorated
  `topic.consumerKey(shard)` PLUS `shard` to `getReadStream`, and core's
  `iterateStream` (`streamable.ts:277`) shard-decorates again — a sharded
  `StreamConsumer` blocks on a doubly-sharded key and never receives its messages
  (writes double-decorate too, `streamable.ts:89`). Pinned RED by
  `key-routing.test.ts` 1.2c; falsifies the audit's 1.2c belief at machine altitude.
- **A9 — suspected listen-arming race (core/consumer).** Under full-parallel suite
  load, exactly one machine round-trip test intermittently misses its response
  (roaming: 1.1a one run, 1.7b another; never reproduced in 6 isolated runs).
  Signature: first message written immediately after `connectAndListen` resolves is
  occasionally never processed — consistent with the read loop arming its `'$'` cursor
  after the write lands (the same cursor-race class as the gateway self-heal Q9/GW15
  work). Suspected, not yet pinned; needs a dedicated tight-loop repro test.
- **A10 — cosmetics/intelligibility.** `quietLogger` is not honored by the machine
  (`createStreamersonLogger` wraps it but JSON still reaches stdout); the 2.12 error
  interpolates the undefined dataKey (`State counters::undefined is not locally
  held`) instead of naming the property target.
- **A11 — `getHash` missing-key wart.** Returns `{}` (truthy `hGetAll` reply), never
  `null`. Pinned with a wart comment.

## Test-phase sequencing (for the next conversation)

1. **Gate** — construction smoke test (2.9); everything else is unrunnable if it fails.
2. **Consistency matrix** — owner/replicated/rent × get/set/incr/setHash against real
   Redis, pinning 1.3–1.5 GREEN and 2.3, 2.5, 2.6, 2.10, 2.11 RED.
3. **Invalidation** — manual tracking enablement to pin 2.1/2.2 RED.
4. **Wire** — transfer dispatch throw (2.4), broadcast message-type value (2.8),
   transfer precondition (2.12).
5. **Lifecycle/contract** — handler signature pin and connection-leak check (2.13).
6. **Deferred pending spec decisions** — 2.7 (replication-failure contract), 3.1
   (transfer receive side), 3.2 (hydration strategy), 3.3 (delete semantics).
