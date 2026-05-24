# Spec — Request Stream Receipt (reliable consumer-group delivery, Architecture A)

Status: **proposal for review — no code yet.** Implements the contract and the design chosen in
[`/CONSUMER_GROUP.md`](../../CONSUMER_GROUP.md) (Part 7). Read that first; this document is
the actionable build + TDD plan. Decisions D1–D4 and the Q5 binding (rationale in
CONSUMER_GROUP.md Part 7) are assumed settled; §11 lists what still needs your sign-off before coding.

---

## 1. Goal & scope

**Goal — the receipt invariant.** Every message added to a topic's consumer stream *after the
group exists* reaches exactly one terminal state, and the failure set never under-reports:

- **DONE** — handler succeeded and the entry was `XACK`'d. Effect committed **at most once** in
  default mode.
- **FAILED** — durably written to a dead-letter stream with cause + provenance; replayable.

Never **silently dropped**, never **stuck non-terminal with no owner**. Error direction is
conservative: FAILED may over-report (a succeeded-but-unacked entry can be dead-lettered) but
never under-reports.

**In scope:** Architecture A (PEL + reaper + DLQ) across `core` and `consumer`; the
coordinator/member split (D3); empty-member-id rejection (D1); wiring `idleTimeout` /
`processingTimeout` (Q5); the prerequisite local-concurrency fixes (CG-I1/I2/I4/I5); opt-in retry.

**Out of scope / deferred:** Architecture B (durable per-message inbox) — opt-in, later, per
topic. The cluster's worker-spawn mechanism is now **done** (native Bun `Worker`, D4): `cluster.ts`
spawns/supervises members and `runClusterMember` hosts them; this spec defines the member/coordinator
*behavior* that spawner instantiates.

**Non-goals:** exactly-once *external* effect (impossible at this layer — requires the dedup key
inside the external system's transaction; see CONSUMER_GROUP.md §7.5). The framework only makes
handlers idempotency-friendly by always passing a stable `messageId`.

---

## 2. Terminal-state machine

```
                 XREADGROUP '>' (NOACK removed → entry enters this consumer's PEL)
   produced ───────────────────────────────────────────────▶ DELIVERED (in PEL)
                                                                  │
                       ┌──────────────────────────────────────── │ ───────────────────────────┐
              handler ok                          handler threw / no handler        process dies / never finishes
                       │                                          │                             │
   bidirectional? ── yes ─▶ EVALSHA RESPOND_AND_ACK        retry off ─▶ EVALSHA            (entry stays in PEL,
                       │     {XADD producer; XACK}          DEADLETTER_AND_ACK             idle grows)
                       └── no ─▶ XACK                        {XADD dlq; XACK}                     │
                       │                                    retry on ─▶ leave in PEL              │
                       ▼                                    (no ack) → reclaim/redeliver          ▼
                     DONE                                    up to maxAttempts, then DLQ    reaper: XAUTOCLAIM
                                                                   │                        (idle ≥ processingTimeout)
                                                                   ▼                        → EVALSHA DEADLETTER_AND_ACK
                                                                 FAILED ◀───────────────────── {XADD dlq; XACK}
```

Two paths to FAILED: **inline** (a *known* failure the handler surfaced now) and the **reaper**
(an *abandoned* entry nobody terminalized). Both use the same atomic `{XADD dlq; XACK}`.

---

## 3. Component model (D3 — split coordinator from member)

Today `ConsumerGroupConfigurator extends ConsumerGroupMember` with `groupMemberId: ''`, so the
coordinator *consumes* (CG-B2). Replace with **composition**; no inheritance chain between the two
roles.

### 3.1 `ConsumerGroupCoordinator` (new — replaces `ConsumerGroupConfigurator`)
A creator + janitor that **never runs handlers**. Holds one `StreamingDataSource` (control-capable),
not a `StreamConsumer`.
- `create(cursor?, shard?)` — `XGROUP CREATE … MKSTREAM`; **surfaces failure** (CG-A5 fix): returns
  a discriminated result / throws on non-`BUSYGROUP` errors instead of swallowing.
- Hosts the **reaper** (§6). Owns the reserved reaper consumer name `__reaper`.
- `connectAndListen()` here means "connect + start the reaper loop", *not* "read messages".

### 3.2 `ConsumerGroupMember` (revised)
- **Constructor rejects an empty `groupMemberId`** (D1): `throw new Error('groupMemberId must be a
  non-empty string')`. Removes the `''` foot-gun at the source.
- Replaces the pipe-based `connectAndListen` with the bounded consume loop (§5) for the group case.
- Terminal transitions run on the **control connection** (`_control`) so they don't queue behind
  the next blocking read on the data connection.

### 3.3 `ConsumerGroupCluster` (mechanism now native Bun `Worker` — D4 done)
- "Spawn N members with distinct ids" via `createMemberOptions(groupMemberId)` → distinct
  `groupMemberId`. Spawns a fixed, runtime-mutable `count` (CG-F4), with restart-on-crash. **Piscina
  is removed**; the spawn primitive is Bun `Worker` (`new Worker(fileTarget)` + `runClusterMember`).
  This spec still owns the member/coordinator *contract* the spawner depends on.

### 3.4 Dead code
`consumer/src/utils.ts` (`createConsumerGroup`, `acquireGroupMemberId`) — unexported/unimported
(FEATURES #47–48). Either **delete**, or revive `acquireGroupMemberId` (INCR-based, max-enforcing)
as the auto-allocator for distinct member ids. Decide in §11.

---

## 4. Data model

### 4.1 Keys (derived from `Topic`)
- consumer (request) stream — `topic.consumerKey(shard)` (unchanged).
- producer (response) stream — `topic.producerKey(shard)` (unchanged).
- **dead-letter stream — new `topic.deadLetterKey(shard)`.** Proposed derivation reusing the existing
  decorators: `…::DEAD_LETTER`. (New `Topic` method — propose in §9.)

### 4.2 Wire fields (must match `streamable › writeToStream`, decoded by name in `parseStreamReply`)
`messageId, messageType, incomingStream, messageHeaders, messageProtocol, messageSourceId, payload`.
The Lua scripts emit these **field names** (order irrelevant — `parseStreamReply` maps by name).

### 4.3 Dead-letter entry fields
`messageId` (original correlation id), `reason` (`no-handler` | `handler-threw` | `abandoned`),
`consumer` (member id that last held it), `deliveryCount`, `payload` (original payload json),
`failedAt` (ms). The DLQ is a plain stream (no group) — drained to SQL by reverse-streamers,
consistent with the retention strategy (`core/types.ts › DataSourceOptions.maxLen`).

### 4.4 In-flight tracking
The group **PEL** (so `NOACK` is removed). PEL size is bounded by in-flight concurrency (§5 keeps it
≈ 1 per member). An entry leaves the PEL only via `XACK` (success, inline-DLQ, or reaper).

---

## 5. Read & terminal-transition path (the member loop)

Replaces, **for the group case**, the racey `Readable.from(iterateStream)` pipe (which causes CG-I1
listener leak and CG-I2 in-flight drop). The generic `getReadStream`/`iterateStream` stays for
non-group reads (e.g. the gateway awaiter's response stream).

```
async connectAndListen():
  connect data + control connections
  while (!closing):
    reply  = readAsGroup(consumerKey, '>', groupId, memberId, block=idleTimeout, count=PREFETCH)
    events = parseStreamReply(reply)            // 0..PREFETCH; default PREFETCH = 1
    for event in events:
      outcome = await dispatch(event)            // discriminated result (§5.1)
      await terminal(event, outcome)             // on control connection (§5.2)
      if (closing) break
  // graceful: loop exits only between messages; in-flight one is terminalized first (CG-I3)
```

Key properties:
- **`NOACK` removed** in `readAsGroup` → every delivered entry is tracked in the PEL.
- **Bounded in-flight (no prefetch buffer):** `PREFETCH` defaults to **1** and the loop fully
  terminalizes message *n* before reading *n+1*. This keeps the PEL ≈ 1 per member, so the
  abandonment grace only has to exceed a *single* handler's worst-case time (not `N ×` it). Prefetch
  > 1 is an opt-in throughput knob with the documented constraint `processingTimeout ≥ PREFETCH ×
  max-handler-time`.
- **Termination is a `closing` flag check between messages** — not the `abort`/`CANCEL`/`UPDATE`
  race. This removes CG-I1 (no per-iteration `once(UPDATE)`), and an interrupted in-flight read's
  delivered entries are safe in the PEL (CG-I2 → reaper).

### 5.1 `dispatch(event)` → discriminated outcome (fixes CG-I4/I5)
Replaces "return an `Error` object" (truthy → false-acked). Outcome is a tagged union:
```
type Outcome =
  | { ok: true;  payload: Record<string,NullablePrimitive> }
  | { ok: false; reason: 'no-handler' | 'handler-threw'; error?: unknown }
```
- No handler registered → `{ ok:false, reason:'no-handler' }` (a config error; retry won't help).
- Handler throws → caught → `{ ok:false, reason:'handler-threw', error }` (**callback always
  resolves — no pipeline wedge, CG-I5**).
- Handler returns → `{ ok:true, payload }`.

### 5.2 `terminal(event, outcome)` (on the control connection)
- `ok` && bidirectional → **`EVALSHA RESPOND_AND_ACK`** (atomic `{XADD producer; XACK}`; fixes CG-I6
  — response is durable iff the request is acked).
- `ok` && !bidirectional → **`XACK`** (plain; no response needed).
- `!ok` && reason `no-handler` → **`EVALSHA DEADLETTER_AND_ACK`** (no retry — config error).
- `!ok` && reason `handler-threw`:
  - retry **off** → **`EVALSHA DEADLETTER_AND_ACK`** (terminal failure now).
  - retry **on** → **do nothing** (leave in PEL, unacked) → redelivered/reclaimed and re-run up to
    `retry.maxAttempts`, then force-DLQ (§7).

A crash *before* `terminal` completes leaves the entry in the PEL → the reaper terminalizes it. A
crash in the irreducible window *after* a side effect commits but *before* `terminal` → conservative
over-report (entry dead-lettered though it ran once). Acceptable per §1.

---

## 6. The reaper (terminalizes abandonment)

Runs on the **coordinator** (it has no handler work and exists once per group). Concurrent reapers
(multiple coordinators) are **safe** — `XAUTOCLAIM`'s atomic idle-reset means a second reaper's
`min-idle` filter excludes an entry the first just claimed.

```
every reaperInterval (default = processingTimeout):
  cursor = '0-0'
  do:
    [cursor, claimed] = XAUTOCLAIM consumerKey group '__reaper' processingTimeout cursor COUNT 100
    for [streamMessageId, fields] in claimed:
      EVALSHA DEADLETTER_AND_ACK
        keys: [deadLetterKey, consumerKey]
        args: [groupId, streamMessageId, fields.messageId, 'abandoned', '__reaper',
               deliveryCount(best-effort), fields.payload, now]
  while cursor != '0-0'
```

- `min-idle = processingTimeout` (the abandonment grace; Q5). An entry only reaps once idle ≥ grace,
  so a merely-slow (not dead) member is not stolen — *provided* grace ≥ max-handler-time (the §5
  `PREFETCH=1` choice makes this a single-handler bound).
- Reaper crash mid-sweep ⇒ claimed-but-not-DLQ'd entries sit in `__reaper`'s PEL with idle reset; the
  next sweep (after grace) re-claims and DLQs them. No loss, no double-DLQ (the `{XADD dlq; XACK}` is
  one atomic Lua). The only failure mode is *liveness* (no reaper ⇒ limbo persists), documented.
- `deliveryCount` is best-effort from `XAUTOCLAIM` (it bumps the count); fetch via `XPENDING` only if
  we later need it exact.

---

## 7. Opt-in retry (off by default)

Config `retry?: { maxAttempts: number }`. When present:
- **Self-recovery on (re)start:** before reading `'>'`, the member drains its **own** PEL by reading
  id `'0'` until empty (re-runs its previously-delivered-unacked entries), then switches to `'>'`.
- **Cross-machine reclaim:** a reclaim pass (member-side or coordinator-side) `XAUTOCLAIM`s stale
  entries (idle ≥ `processingTimeout`) and **re-runs the handler** (instead of the reaper's DLQ).
- **Poison-message termination:** when an entry's delivery count exceeds `maxAttempts`, force
  `EVALSHA DEADLETTER_AND_ACK` (reason `handler-threw`, with the attempt count). Guarantees liveness —
  a permanently-failing message can't loop forever.
- **Contract shift:** retry = at-least-once ⇒ handlers **must be idempotent** (double-execution is
  possible). The framework passes the stable `messageId` for dedup. Without retry, the default stays
  at-most-once (no re-run anywhere; reaper only *records*).

---

## 8. Lua scripts (atomic terminal transitions)

Loaded once via `SCRIPT LOAD` on connect; called with `EVALSHA`, `EVAL` fallback on `NOSCRIPT`. Run
through the same raw `client.send(...)` escape hatch used for all stream commands. *(**Confirmed**
by probe: `SCRIPT LOAD` → sha, `EVALSHA` runs the script, and direct `EVAL` works as the `NOSCRIPT`
fallback — all via Bun `RedisClient.send()`.)*

**RESPOND_AND_ACK** — bidirectional success (atomic response + ack):
```lua
-- KEYS[1]=producer stream  KEYS[2]=consumer stream
-- ARGV: 1=groupId 2=streamMessageId 3=messageId 4=messageType 5=messageSourceId 6=payload(json)
redis.call('XADD', KEYS[1], '*',
  'messageId', ARGV[3], 'messageType', ARGV[4], 'incomingStream', '',
  'messageHeaders', 'nil', 'messageProtocol', 'json',
  'messageSourceId', ARGV[5], 'payload', ARGV[6])
redis.call('XACK', KEYS[2], ARGV[1], ARGV[2])
return 1
```

**DEADLETTER_AND_ACK** — inline known-failure *and* reaper abandonment (atomic record + ack):
```lua
-- KEYS[1]=dead-letter stream  KEYS[2]=consumer stream
-- ARGV: 1=groupId 2=streamMessageId 3=messageId 4=reason 5=consumer 6=deliveryCount 7=payload 8=failedAt
redis.call('XADD', KEYS[1], '*',
  'messageId', ARGV[3], 'reason', ARGV[4], 'consumer', ARGV[5],
  'deliveryCount', ARGV[6], 'payload', ARGV[7], 'failedAt', ARGV[8])
redis.call('XACK', KEYS[2], ARGV[1], ARGV[2])
return 1
```

Non-bidirectional success uses a plain `XACK` (no Lua — single op, no atomicity needed).

---

## 9. `core` API changes (`packages/core`)

`datasource/streamable.ts`:
- `readAsGroup(stream, cursor, groupId, groupMemberId, timeout, count = 1)` — **remove `NOACK`**;
  parameterize `COUNT` (default 1) and keep `BLOCK` from caller; allow `cursor` `'0'` for the retry
  self-drain (currently hard-coded `'>'`).
- `blockingStreamBatchMap` — pass `blockTimeout` through as `BLOCK`; pass `cursor`/`count` through.
- new `claimStale(stream, groupId, consumer, minIdle, cursor, count)` → `XAUTOCLAIM` wrapper returning
  `{ cursor, entries }`.
- new script runners `respondAndAck(...)`, `deadLetterAndAck(...)` (EVALSHA + NOSCRIPT fallback);
  `_scriptShas` populated in `connect()` via `SCRIPT LOAD`.
- `markProcessedByGroup` — keep (plain `XACK`, non-bidirectional success path).

`utils/topic.ts`:
- new `deadLetterKey(shard?)` (decorator-derived, e.g. `…::DEAD_LETTER`).

`datasource/base/remote.ts`:
- `connect()` also `SCRIPT LOAD`s the two scripts and stores SHAs.
- `disconnect()` — **drain in-flight + flush pending acks before closing `_control`** (CG-I3): close
  ordering becomes data-connection first (stop new reads), then await the in-flight terminal, then
  close control. (Coordinated with the member loop's `closing` check.)

`blockTimeout` → `BLOCK` threads from `consumer` config (below). **Note:** `idleTimeout` is *not* the
read BLOCK — the shipped cluster already uses it as the drain budget; the BLOCK cadence is a new field.

---

## 10. `consumer` API changes (`packages/consumer`)

- `config.ts` — reconcile with the **shipped** cluster vocabulary (`count`/`processingTimeout`/
  `idleTimeout` already exist; `min`/`max` are gone):
  - `processingTimeout` — **double duty, one value:** the worker-side handler budget (already wired in
    `cluster-member.ts › wrapHandlers`) *and* the reaper/reclaim `min-idle` (abandonment grace).
    Safe-by-construction — a handler is locally killed exactly when its PEL entry becomes reclaimable.
    `0` disables both.
  - `idleTimeout` — **unchanged from shipped:** the graceful-drain budget. *Not* the read BLOCK.
  - **new `blockTimeout?` (default 100)** → `XREADGROUP BLOCK` cadence (replaces hard-coded
    `DEFAULT_BLOCKING_TIMEOUT`). Distinct field so it doesn't collide with `idleTimeout`.
  - new `retry?: { maxAttempts: number }`; new `prefetch?: number` (default **1**, with the
    `processingTimeout ≥ prefetch × handler-time` constraint). Extend `validateOptions`.
- `member.ts` — reject empty `groupMemberId` (D1); discriminated `dispatch` (§5.1); `terminal` (§5.2);
  replace pipe `connectAndListen` with the bounded loop (§5); terminal ops on control connection.
- `group.ts` — replace `ConsumerGroupConfigurator` with `ConsumerGroupCoordinator` (composition; no
  read; surfaces create failures; hosts reaper §6).
- `cluster.ts` — **done:** Piscina dropped; native Bun `Worker` spawner with distinct-id member
  options + fixed runtime-mutable `count` + restart-on-crash (D4). Worker side: `runClusterMember`.
- `utils.ts` — delete or repurpose (§3.4 decision).

---

## 11. Decisions (settled)

All six review questions are resolved:
1. **Prefetch = 1** (reliable default; `prefetch > 1` opt-in under `processingTimeout ≥ prefetch ×
   handler-time`). ✓
2. **`handler-threw` (retry-off) → inline DLQ**; no-handler always inline. ✓
3. **`deadLetterKey` = `…::DEAD_LETTER`, one per topic+shard.** ✓
4. **Delete `consumer/src/utils.ts`** — dead, and its `INCR` allocator yields *ephemeral* (not stable)
   ids, so it doesn't serve resumption; stable-id allocation, if ever wanted, is a separate deliberate
   design. ✓
5. **`retry?: { maxAttempts }`** grouped block; `processingTimeout` shared as the grace. ✓
6. **Coordinator is the sole reaper host.** ✓

**Newly surfaced during ground-truthing (proposed — confirm): config vocabulary.** The shipped cluster
already binds `processingTimeout` = handler budget and `idleTimeout` = drain budget, diverging from the
original Q5 sketch. Reconciliation (§10): `processingTimeout` does double duty (handler budget = reaper
`min-idle`), `idleTimeout` stays the drain budget, and a **new `blockTimeout` (default 100)** carries
the read `BLOCK` cadence. Additive and non-breaking — confirm the `blockTimeout` name/default.

---

## 12. Build & TDD sequence

Integration-first (real Redis, per CLAUDE.md): each phase begins with a **failing** integration test
that encodes the contract, then the implementation, then the test stays as a regression guard. Phases
are independently shippable.

- **Phase 0 — prove the path + primitives. (Largely DONE.)** ✅ `cluster.test.ts` already drives a
  real `echo` request → worker handler → correlated response off the producer key (CG-C5/H2/H3), plus
  restart-on-crash. ✅ Bun `EVALSHA`/`EVAL`-via-`send()` confirmed by probe (§8). **Remaining:** pin
  CG-I1 — a regression test that an idle member doesn't accumulate `UPDATE` listeners (it will regress
  the moment we touch the read loop, so lock it first).
- **Phase 1 — no silent loss. ✅ DONE** (`packages/consumer/test/receipt.test.ts`). Removed `NOACK`
  (`readAsGroup`); rewrote the member into a bounded background read loop (PREFETCH=1) with
  discriminated `dispatch` + `terminal` (fixes CG-I4 false-ack and CG-I5 wedge); respond-before-ack;
  ack only on genuine success. Bypassing `iterateStream` fixes CG-I1 **for the member**. Added
  `blockTimeout`/`prefetch` config + `RedisDataSource.isClosing`. Verified: a thrown handler leaves
  its entry pending (`XPENDING`=1, recoverable) while a later message is still answered; full suite +
  cluster regression green.
  - **Deferred to Phase 2:** D1 (reject empty `groupMemberId`) — currently an empty id is a
    *connect-but-don't-consume* coordinator bridge so `bootstrap.test` stays green; the hard error
    lands with the structural coordinator/member split.
  - **CG-I1 fully closed:** `iterateStream` (the shared `getReadStream` path used by the gateway
    awaiter) now uses one persistent UPDATE/CANCEL listener + a re-armable wake promise, with `finally`
    cleanup — no per-cycle `once(UPDATE)` accumulation, and listeners are removed when iteration ends.
    Guarded by `packages/core/test/streams/datasource/iterate-stream-listeners.test.ts` (idle consumer:
    peak ≤ 2 listeners, 0 after teardown). Behavior-preserving (same UPDATE→abort / CANCEL→exit).
- **Phase 2 — coordinator/member split + create safety. ✅ DONE** (`packages/consumer/test/coordinator.test.ts`).
  - **D3 split:** `ConsumerGroupConfigurator` (a member with `groupMemberId:''`) **replaced** by
    `ConsumerGroupCoordinator` — composition, holds one control-capable `StreamingDataSource`, no
    `StreamConsumer` inheritance, **never issues `XREADGROUP`**. `cluster.ts` now constructs/`connect()`/
    `create()`/`disconnect()`s the coordinator; `start()`/`stop()` updated. CG-B2 closed (regression:
    all N produced messages reach the member; `XINFO CONSUMERS` shows only the real member, no `''`).
  - **CG-A5:** core `createConsumerGroup` returns the `'BUSYGROUP'` sentinel on an existing group and
    **propagates any other error** (e.g. WRONGTYPE); `coordinator.create()` returns `{ created }` and no
    longer swallows. Test forces WRONGTYPE (string key under the consumer key) and asserts the throw.
  - **D1 (now hard):** `ConsumerGroupMember` constructor **throws** on an empty `groupMemberId`; the
    Phase-1 empty-id "coordinator bridge" branch in `connectAndListen` is removed. `bootstrap.test`
    migrated to the coordinator.
  - **CG-D4 cleanup:** the dead `acknowledgeProcessed` toggle removed from `ConsumerGroupMemberSettings`
    and `cluster-protocol.ts › MemberSettings` (the bounded loop always acks on genuine success).
  - **CG-G2/G3 (base path):** `StreamConsumer.connectAndListen`'s pipe — load-bearing for every
    non-group single consumer (`app-*`, gateways, benchmarking, `state-machine`'s `super` call) — fixed:
    the `'…cijkdcjidkfj'` cruft removed and `callback()` is now always called in the catch (no head-of-line
    wedge). This eliminates CG-G2/G3 from the codebase, not just the member.
  - **Dead code:** `consumer/src/utils.ts` deleted (§3.4 decision #4); the example
    `consumer-group-readable.ts` migrated to the coordinator + `count` (was stale `max`).
  - Full suite 51 pass / 2 skip / 0 fail.
- **Phase 3 — terminality (reaper + DLQ + Lua). ✅ DONE**
  (`packages/consumer/test/terminality.test.ts`, `reaper.test.ts`; `receipt.test.ts` updated to the
  terminal contract).
  - **`Topic.deadLetterKey(shard?)`** → `…::DEAD_LETTER` (plain stream, no group).
  - **Atomic Lua transitions in `core`:** `RESPOND_AND_ACK_LUA` / `DEADLETTER_AND_ACK_LUA` are
    `SCRIPT LOAD`ed in `StreamingDataSource.connect()` (override) and run via `EVALSHA` with a
    transparent `EVAL` fallback on `NOSCRIPT` (`evalScript`). New methods: `respondAndAck`,
    `deadLetterAndAck`, `claimStale` (XAUTOCLAIM wrapper → `{ cursor, entries }`), all on the control
    connection. `createConsumerGroup` already throws on real errors (Phase 2).
  - **Member terminal (`member.terminal`)** now: bidirectional success → `respondAndAck` (atomic
    `{XADD response; XACK}`, fixes CG-I6); one-way success → plain `XACK`; failure (no retry) → inline
    `deadLetterAndAck` (`no-handler` / `handler-threw`). This supersedes Phase 1's "leave pending":
    known failures are terminal-FAILED now; only *abandonment* stays in the PEL for the reaper.
  - **Reaper on the coordinator** (`ConsumerGroupCoordinator.startReaper/stopReaper/sweep`): every
    `processingTimeout` ms, `XAUTOCLAIM` entries idle ≥ `processingTimeout` into `__reaper` →
    `deadLetterAndAck` (reason `abandoned`). Disabled when `processingTimeout === 0` (no safe idle
    threshold). NOGROUP-tolerant; non-overlapping (`sweeping` guard). `cluster.start()` calls
    `startReaper()` after `create()`.
  - **`CONSISTENCY.md` updated:** the "no `EVAL` / no `XPENDING`/`XCLAIM`" claim and the "`NOACK`
    at-most-once, ack path inert" delivery note are corrected to the new PEL+reaper+DLQ+Lua reality;
    Gap C marked substantially done.
  - Verified: terminality (echo→response present + PEL drained; boom→DLQ `handler-threw`;
    mystery→DLQ `no-handler`; PEL=0) and reaper (abandoned entry → DLQ `abandoned` exactly once, PEL
    drained, no re-DLQ on later sweeps). Full suite 53 pass / 2 skip / 0 fail.
  - **Follow-up resolved (cleanup):** a bidirectional member writes its response via `respondAndAck`
    on the *incoming* channel's control connection, so the base-created `outgoingChannel`/`outgoingStream`
    are dead weight for a member. The member constructor now nulls them and `connectAndListen` opens only
    the incoming channel — no more idle second connection per member. The unused `StreamConsumer.setOutgoingChannel()`
    (zero callers) was removed. The base `StreamConsumer` and `StreamStateMachine`, which do use the
    outgoing channel, are unchanged. Suite still 59 pass / 2 skip / 0 fail.
- **Phase 4 — opt-in retry. ✅ DONE** (`packages/consumer/test/retry.test.ts`).
  - **Config:** `retry?: { maxAttempts }` on `ConsumerGroupOptions` / `StreamConsumerOptions` /
    `ClusterConnectionSettings`; `validateOptions` requires `maxAttempts ≥ 1` **and**
    `processingTimeout > 0` (the reclaim idle threshold — `0` would steal in-flight work, CG-I7).
    `processingTimeout` also threaded to the member as the reclaim `min-idle`.
  - **Single consume loop (§6.3):** the member feeds one serialized pipeline from, in order,
    `[self-PEL drain at '0' on (re)start] → [reclaim stale, retry-only, throttled to once per grace]
    → [XREADGROUP '>']`. `terminal` now leaves a thrown handler **pending** in retry mode (no-handler
    still inline-DLQs — retry can't fix a config error).
  - **core primitives:** `readGroupEntries` (read at an explicit cursor — `'0'` = own PEL, non-blocking,
    bumps delivery count), `pendingDetails` (XPENDING extended → per-entry delivery count). `attempt`
    caps re-runs: `deliveryCount > maxAttempts` → poison → `deadLetterAndAck`.
  - **Self-recovery** (restart, same id) re-runs own pending until drained (each '0' re-read bumps the
    count, guaranteeing termination via the poison cap). **Cross-machine reclaim** `XAUTOCLAIM`s stale
    entries into the live member and re-runs them. In retry mode the **coordinator reaper is disabled**
    (`startReaper` no-ops) — members own reclaim, so the reaper must not also DLQ.
  - Verified: (1) redelivery after a "crash" — member 2 (same id) self-drains and an idempotent handler
    succeeds (≥2 runs, acked, no DLQ); (2) an always-failing handler is re-run then dead-lettered with
    `deliveryCount > maxAttempts`; (3) CG-I7 — with `processingTimeout`(1000) > handler(150), a healthy
    entry is never reclaimed (runs exactly once). Full suite 56 pass / 2 skip / 0 fail.
- **Phase 5 — cluster verify & extend. ✅ DONE** (`packages/consumer/test/cluster-lifecycle.test.ts`).
  - **Verified:** member **longevity** under sustained load (30 messages → all distributed and answered
    exactly once, 3 members survive); `scale()` **up/down reconcile** (2→4→1, `readyMembers`/`members`
    track; the survivor still serves); graceful **drain flush** (an in-flight 600 ms handler completes
    and its response is flushed within `idleTimeout` on `stop()`, PEL drained).
  - **Bug found & fixed (CG-I3) while verifying drain:** Phase 3 moved the response write onto the
    *incoming* channel's control connection, but the worker's drain disconnected `incomingChannel`
    *before* waiting for in-flight work — so an in-flight response could no longer flush, and the
    worker's `inFlight` counter only covered the handler, not the terminal transition. **Fix:**
    member-owned `drain(idleTimeoutMs)` — set a `draining` flag (stop pulling new work), wait for the
    member's own `inFlight` (which now wraps the *whole* handler+terminal) to reach 0 bounded by
    `idleTimeout`, *then* disconnect. `runClusterMember.drain` delegates to it; `wrapHandlers` keeps
    only the `processingTimeout` budget. This closes CG-I3 (drain in-flight + flush before close); an
    abrupt `disconnect()` still leaves in-flight entries pending for the reaper/retry (no loss).
  - Full suite 59 pass / 2 skip / 0 fail.

---

*Cross-reference:* design rationale & resolution in `/CONSUMER_GROUP.md` (Part 7 design, Part 8
as-built, Part 9 verification); the ordering/reliability split in [`CONSISTENCY.md`](./CONSISTENCY.md)
(this spec closes its **delivery** axis / PROJECT.md Gap C); gaps in `/PROJECT.md`.

> **Note:** `CONSISTENCY.md` currently states the framework uses **no `EVAL`**. The atomic
> `{XADD; XACK}` Lua here introduces `EVAL`/`EVALSHA` for *delivery reliability* (record+ack atomicity)
> — not a cross-key application-consistency protocol. Update `CONSISTENCY.md` when this lands.
