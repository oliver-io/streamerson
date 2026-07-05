# State-machine test plan

> **STATUS (2026-07-04): IMPLEMENTED.** 12 test files under `test/` (shared
> `harness.ts` + 11 suites), 84 tests: **54 GREEN / 29 intentional spec-RED /
> 1 documented skip** (2.10 fetch-failure companion — no deterministic seam).
> Two approved spec-neutral product fixes landed during the phase (audit addenda
> A3/A4: `declare streamEvents`, lru-cache import/options). One stable unexpected
> RED: 1.2c, pinning the new consumer-layer double-shard defect (addendum A8). One
> roaming flake under parallel load: suspected listen-arming race (addendum A9).
> New findings are recorded in BEHAVIOR_AUDIT.md "Addenda". The sections below are
> the original logical designs.

Companion to `BEHAVIOR_AUDIT.md`. Three suites, one per audit category, unified by a
single harness. Philosophy (non-negotiable): integration-test-driven; **never mocks**;
real Redis (docker compose, localhost:6379), real node-redis clients, real streams;
assertions are about **behavior** (values returned, keys/entries in Redis observed by an
out-of-band client), never implementations; spies/public-state probes (`cache.has`) are
permitted only as secondary sanity checks. Tests are a living spec:

- **Category 1 tests land GREEN** — pins of behavior believed correct.
- **Category 2 tests assert the spec and land RED** — each carries a clearly-labeled
  companion `PIN(n.m)` assertion of today's wrong behavior so the eventual fix
  consciously flips both.
- **Category 3 tests are spec-capture** — RED by design where the contract is already
  unambiguous; everything else waits on the Decision List (§6).

## 0. Audit addenda discovered during test design

Two behaviors not recorded in BEHAVIOR_AUDIT.md, found while enumerating the flag
matrix — record before the matrix suite lands:

- **A1 — silent no-op writes.** Configs with `owner: false, rent: false` never set
  `dispatchRemote`; every write "succeeds" while writing nowhere (`cacheable.ts:44-67,
  158-182`). Category 2-adjacent.
- **A2 — owner-only `get` blindness.** `get` only consults the LRU when
  `replicated || rent` (`cacheable.ts:87-99`); for `owner: true, replicated: false`,
  `set` populates the LRU but `get` bypasses it and reads never-written Redis → returns
  `null` for state the owner just wrote. Adjacent to 2.5 but distinct (read-side, not
  durability).

## 1. Shared harness — `packages/state-machine/test/harness.ts`

Ports the consumer harness primitives (`consumer/test/harness.ts`): `REDIS` env config,
`sleep`, `until(fn, ms, step)` (poll-with-deadline; **never fixed sleeps** for positive
waits), `makeTopic(tag)` per-run-unique topics, `write()` message injection,
`awaitResponse()`, `readEntries()` raw XRANGE→field-map decoding, `testRig()` LIFO
teardown. State-machine-specific additions:

1. **`canConstruct()` gate probe + `assertGateOrSkip()`** — module-level try/catch
   around `new CacheableDataSource(...)`; every suite skip-gates behind it so a RED
   gate yields 1 loud failure + N explicit skips, not N cascading crashes.
2. **`rawObserver()`** — a plain node-redis client (same library the datasource uses)
   as the out-of-band ground-truth oracle: `GET/HGETALL/SET/DEL/EXISTS/XRANGE/CLIENT
   LIST/CLIENT KILL/PUBLISH`.
3. **Key namespacing + teardown sweep** — per-test prefix
   (`itest-sm:<tag>-<ts>-<rand>:`); teardown: disconnect (LIFO) → settle → DEL tracked
   keys → prefix `SCAN` sweep (catches fire-and-forget writes landing post-DEL) →
   observer quit.
4. **`makeMachine(rig, {stateConfigurations, shard, handlers})`** — fresh topic,
   handlers via `registerStreamEvent`, `connectAndListen`, tracked. Plus
   **`expectedKeyFor(machine, propertyTarget, context?)`** computing the physical Redis
   key the public way (Topic + `cacheComposite` + `shardDecorator`) so key assertions
   never hardcode strings.
5. **`makeDatasource(rig, config?)`** — bare connected `CacheableDataSource`/`StateCache`
   for matrix-altitude tests.
6. **`awaitReplicated(observer, key, expected, ms=2000)`** (+ hash variant) — the ONLY
   sanctioned way to observe fire-and-forget replication: `until` on observer read,
   then a hard `expect` on the final value so timeouts produce a diff.
7. **`never(fn, ms≈300)`** — fixed-window negative check ("key never appears",
   "no response after disconnect"), per the consumer harness's negative-check doctrine.
8. **`enableTrackingLikeTheSpec(ds)`** — fetch the invalidation connection's client id
   (`clientId()` before subscribe, or `CLIENT ID` via sendCommand) and issue a real
   `CLIENT TRACKING ON REDIRECT <id>` on `cachedChannel` (directly or via
   `ds.enableCache`). This is the spec's missing wiring performed by the test — not a
   mock.
9. **`restartAs(configFactory)`** — owner-restart simulation: disconnect (clean
   variant) or abandon (crash variant) instance A; construct B with identical
   topic/shard/stateConfigurations; `afterAll` `CLIENT KILL`s abandoned connections.
10. **`clientCount(filter)`** — `CLIENT LIST` accounting with `CLIENT SETNAME` tagging
    where injectable; counting tests run serial.
11. **`DEBUG SLEEP` probe** — beforeAll capability check; request compose flag
    `--enable-debug-command yes` if absent (only for widened-window 2.10 variants).
12. **Two-machine topology helper** (`makeMachinePair`) — for transfer (3.1) and
    ownership-conflict (3.6) tests: two machines on distinct shards of one topic,
    teardown quitting ALL clients including the transfer channel's datasources.
13. **Harness capability request (not a mock): controllable LRU TTL.** The 600s TTL is
    a hard-coded constant (`cacheable.ts:30`); TTL-expiry behavior is untestable as-is.
    Proposal: honor the existing dead `StateConfiguration.ttl` (`types.ts:36`) or add
    `DataSourceOptions.cacheTtlMs` — a spec decision (D13) to make before coding.
    Until then, restart-simulation is the equivalent cold-cache condition.

## 2. Suite 1 — GREEN pins (Category 1)

Files: `construction.gate.test.ts`, `consistency-matrix.test.ts` (shared with Cat 2),
`ticker-tape-loop.test.ts`, `key-routing.test.ts`, `lifecycle.test.ts`,
`payload-unwrap.test.ts`.

**Altitude rule:** full-loop (real messages through a `StreamStateMachine`) for 1.1,
1.2b/c, 1.6, 1.7; datasource altitude for the consistency matrix (1.3–1.5) — still
behavior-not-implementation because `CacheableDataSource` is a public consistency
contract and observations are external ground truth; one bridge test ties altitudes.

- **Gate (1.0):** G1 `new CacheableDataSource` doesn't throw (the one Cat-1 test
  permitted RED — error message distinguishes lru-cache options-validation from
  namespace-import interop); G2 `StateCache`; G3 `StreamStateMachine` constructs with
  one transformer per state key; G4 connect/disconnect round trip against live Redis.
- **1.1 ticker-tape:** (a) happy loop — inject on consumer stream; handler proves arg 1
  is the transformer map by using it (`set` + assert Redis ground truth); `resp` comes
  back correlated on the producer stream. (b) unknown message type → no response in a
  negative window AND machine stays live for the next valid message. (c) bridge —
  handler `incr`s twice, response says 2, Redis says `"2"`.
- **1.2 routing:** (a) config isolation — three keys (`owner+replicated`, `rent`,
  `owner`-only) behave distinctly per flag (poll / immediate / never in Redis).
  (b) `dataKey` derivation — physical key equals `expectedKeyFor(...)` computed the
  public way. (c) shard suffix — sharded vs unsharded machines land on different keys.
  One scalar + one hash op suffice (single composition code path).
- **1.3 owner writes (matrix core):** local-first return values asserted immediately
  (pre-any-yield), replication observed only via `awaitReplicated`; incr/decr algebra
  converges remotely (deltas → assert final value only); setHash GREEN kept inside the
  flat-strings/single-write envelope (2.11 owns the rest); owner-only writes never
  touch Redis (`never`). No induced failures (2.7's territory), no second instance
  (2.6's), no pre-seeded Redis for incr (2.6's).
- **1.4 renter writes:** awaited durability — observer reads **immediately** after
  resolve, no polling (the behavioral teeth distinguishing this path from 1.3);
  `incr` on pre-seeded `"10"` returns 11 (defers to Redis as truth); renter setHash
  only under `rent && !replicated` (the `rent && replicated` cell is 2.11 RED); renter
  never reads after its own write (2.3's RED).
- **1.5 read-through (sequential only):** miss → populate → hit proven by out-of-band
  delete-then-reread (returns cached value; annotated as flipping when 2.1/2.2 land);
  `has()` as sanity check only; `getHash` `{}`-vs-`null` missing-key return pinned with
  a wart comment; strictly `await`ed sequential reads (2.10 owns concurrency);
  restricted to `replicated || rent` configs (A2 addendum owns owner-only reads).
- **1.6 lifecycle:** connect enables both halves (state op + message round-trip);
  disconnect quiesces (negative window on responses) — weakened form; strict
  connection-count is 2.13's.
- **1.7 payload unwrap:** single- and double-stringified payloads arrive as parsed
  objects; handlers registered via `registerStreamEvent` only (eventMap fork is
  2.13); tests pin, not endorse, the double-unwrap.

**Flag-matrix coverage (trimmed cross-product):** 6 meaningful scalar cells + 2 setHash
cells + 2 read configs; `{owner:F, rent:F}` cells recorded as A1, not smuggled into
GREEN assertions.

## 3. Suite 2 — spec-RED regression guards (Category 2)

Files by infrastructure shape: `construct.gate.test.ts` (2.9, shared with Cat 1),
`invalidation.test.ts` (2.1, 2.2 + control), `consistency-matrix.test.ts` (2.3, 2.10,
2.11), `consistency-recovery.test.ts` (2.5, 2.6, 2.7), `wire.test.ts` (2.4, 2.8, 2.12),
`lifecycle-contract.test.ts` (2.13).

- **2.1 tracking never enabled — two tests.** (A) shipped-connect-path: owner writes;
  renter's next read must see it → RED (stale; `enableCache` has zero call sites).
  (B) with `enableTrackingLikeTheSpec`, plus a harness-only **control test** proving a
  real invalidation push works on this Redis (GREEN control), isolating 2.2 as purely a
  handler defect. PIN: staleness bounded only by the 600s TTL.
- **2.2 wrong handler args.** Seed the LRU behaviorally (renter read); deliver a genuine
  push (primary: real tracking via harness; fallback: `PUBLISH __redis__:invalidate K`,
  wire-equivalent for a RESP2 subscriber and documented as such). Spec: `cache.has(K)`
  → false. RED — handler deletes `args[1]` (the channel name), `cacheable.ts:248-257`.
- **2.3 renter read-your-writes.** get(1) → set(2) → get must be 2; RED (returns 1 —
  the `invalidateCache(null, key)` guard no-ops). Ground truth: Redis really holds 2 —
  only local eviction is broken. Repeat for incr and setHash.
- **2.4 transfer.** PIN(2.4a): rejects with the exact awaiter throw
  (`stream-awaiter.ts:58-63`). Spec (RED): exactly one entry on
  `<target>::incoming_state_transfer` with `messageType === 'xfer'` and payload
  round-tripping `{stateType, stateData}` — entry-appears only; round-trip-resolves
  deferred to 3.1's protocol decisions; test guards itself against the deferral hang
  with a test-side deadline. Also pins that the transfer channel contributes zero
  connections (never connected).
- **2.5 owner-only durability.** TTL is untestable pending D13; the crash-loss variant
  is behaviorally identical: restart via `restartAs`, `incr` → spec N+1, RED 1
  (`?? '0'` default, `cacheable.ts:45`). Ground truth: `EXISTS K === 0`. Honest note:
  the fix may be rename/retype rather than write-through — the RED test forces that
  conversation.
- **2.6 restart divergence.** A incr×5 → `awaitReplicated('5')` → restart → B incr →
  spec: local 6 AND remote 6. RED: local 1, remote 6. PIN asserts both numbers so any
  hydration strategy (3.2) flips both. Clean-shutdown and crash variants.
- **2.7 reconciliation minimal invariant** ("after Redis recovers and one more write,
  remote == local") — **primary variant is timing-free**: the 2.6 divergence followed
  by one more incr never reconverges (local 2, remote 7). The real-outage variant
  (`CLIENT KILL` the cachedChannel mid-window) is `.slow`/optional with a documented
  race. Open spec decision (D-2.7) flagged: is dropped replication an accepted
  tradeoff?
- **2.8 wire values.** Broadcast to a unique stream; observer XRANGE: spec
  `messageType === 'xcast'`, PIN `'BROADCAST'`. Consequence test: a real
  `StreamConsumer` with a handler under the true enum value never fires (RED). TRANSFER
  half folded into 2.4's wire assertion.
- **2.10 sentinel race — deterministic, no server delay needed:** the sentinel is
  written synchronously pre-await, so two same-tick `get`s hit it deterministically;
  `DEBUG SLEEP 0.2` only as belt-and-braces. Spec: both resolve to the real value; RED:
  second returns `'caching in progress'` (and for `getHash`, a string where a Record is
  expected). Companion (timing-sensitive, tagged): sentinel never cleaned on fetch
  failure.
- **2.11 setHash deviations — four sub-tests:** (1) renter-path fork made deterministic
  by asserting durable-or-reject under a killed connection (spec: rejects; pin:
  resolves `true` while nothing lands); (2) aliasing — caller-held record mutation must
  not leak into the cache (both directions); (3) nested values must round-trip, RED
  `'[object Object]'`; (4) deleted-field resurrection via stale local merge base.
  Plus flag-parity matrix vs scalar `set`.
- **2.12 transfer precondition — primary RED needs no TTL machinery:** with a `shard`
  configured, writes key the LRU via `shardDecorator` but `has` checks the raw key →
  transfer throws "not locally held" while the state IS held. Secondary (durable-but-
  evicted) uses restart simulation.
- **2.13 contract fork + leaks:** (A) eventMap-registered handler through a real
  round-trip receives the transformer map (GREEN through `_handle_message`); the RED
  half drives the machine through the cluster's `wrapHandlers` path (one-arg call) —
  micro spec decision D-2.13: which convention is canonical (recommend the
  state-machine one). (B) `CLIENT LIST` returns to baseline after `disconnect` —
  possibly GREEN by accident today; kept as the regression guard that catches the leak
  the moment 2.4's fix connects the transfer channels.

**Risk register:** timing-sensitive = 2.7 outage variant, 2.10 failure-cleanup
companion (both tagged/optional; primaries are deterministic); all replication waits
via `until` on ground truth, never sleeps; `CLIENT TRACKING REDIRECT` needs Redis ≥6
(compose `redis:alpine` — fine); RESP2 pub/sub invalidation is exactly what the product
subscribes to, so default client mode is correct.

## 4. Suite 3 — spec-capture for unimplemented features (Category 3)

**Writable today:**

- **3.1 dispatch wire pin** — lives with 2.4 (entry + `'xfer'` + payload shape).
- **3.2 strategy-agnostic recovery invariants** — I-R1 (restarted owner's incr agrees
  with Redis — the 2.6 test promoted to spec form), I-R2 (restarted owner's first `get`
  equals last written value — likely the GREEN anchor since owner reads with
  `replicated` read through), I-R3 (post-restart convergence is permanent). The
  "bring restarted owner to serving state" setup step is factored as one named
  edit-point so the eventual strategy decision changes setup, not invariants.
- **3.3 delete invariants** — I-D1 (after delete of owned+replicated K: local null AND
  remote absent), I-D2 (renter delete: same + no stale self-serve), written RED against
  `set(K, null)` (the entry point whose TODO already claims delete intent; today it
  returns `false` and deletes nothing). I-D3 (replica stops serving deleted value)
  sequenced after the invalidation suite.
- **3.4 activation contract** — end-to-end staleness (RED; same infrastructure as 2.1A,
  framed as "connect resolves ⇒ tracking live") plus a Redis-side
  `CLIENT TRACKINGINFO`-style observation via the observer connection — justified as
  behavior, not implementation: CLIENT TRACKING is the process's wire contract with
  Redis, the same ground-truth oracle class as XPENDING in the consumer suite.
- **3.6 I-O1 ownership-divergence pin** — two machines, both `owner: true` on the same
  keys, each incr once → document local 1/1 vs remote 2. **GREEN documentary hazard
  pin**, not a RED spec test, because "should be detectable" is undecided (D14).

**Blocked pending decisions (do not write — coding into ambiguity):** all transfer
receive-side invariants (I-T1 exactly-once ownership, I-T3 no lost messages during
handoff, I-T4 idempotent retry, I-T5 rollback-on-timeout); strategy-specific hydration
tests; delete return values and HDEL field semantics; the reconnect leg of replica
activation; ownership-conflict detection.

## 5. Execution order

1. **Gate** (`construct.gate.test.ts`) — everything skip-gates on it; if RED, agree the
   one-line spec-neutral construction fix before the suite is runnable.
2. **Consistency matrix** (datasource altitude; Cat-1 GREEN cells + 2.3/2.10/2.11 RED).
3. **Recovery** (2.5/2.6/2.7 + 3.2 invariants — same restart infrastructure).
4. **Invalidation** (2.1/2.2 control + product, 3.4 activation).
5. **Wire** (2.4 + 3.1 pin, 2.8, 2.12).
6. **Full-loop + lifecycle** (1.1/1.2/1.6/1.7, 2.13, 3.6 pin).

## 6. Consolidated decision list — RESOLVED (with owner, 2026-07-03)

All eight decisions were put to the owner and resolved. The blocked tests in §3/§4 are
now unblocked with these contracts:

| # | Decision |
|---|---|
| D-Hydration | **Lazy owner read-through (S2).** Owner ops on a locally-cold replicated key consult Redis first, then become locally authoritative; requires a "hydrated" marker so `incr` stops defaulting to `'0'`. |
| D-Transfer | **Durable-ack + rollback.** Receiver acks only after write-through to Redis; dispatcher deletes local state on ack; on timeout the dispatcher retains ownership and clears the pending marker; retries are idempotent by transfer message id; in-flight message pending is the ROUTER's responsibility, not the state machine's. |
| D-Delete | **`set(K, null)` is the scalar delete, algebra-symmetric.** Owner: local delete + fire-and-forget `DEL`; renter: awaited `DEL` + local eviction. `setHash(K, field, null)` is an `HDEL` and the local merge drops the field. Returns `true` unconditionally for owners, the Redis reply for renters. |
| D-2.7 | **Bug, with the minimal reconciliation invariant as the fix target:** after Redis recovers and the owner performs one more write, remote == local. Implies value replication (or read-back repair) rather than raw `INCR` deltas. The 2.7 test is a RED spec test, not a documentary pin. |
| D12 | **Flush the LRU on cachedChannel reconnect;** tracking re-enabled before the next cacheable read. |
| D13 | **Purge `local`/`refresh`/`useShard` params/`localStore`; specify per-key `StateConfiguration.ttl`:** owner state with no ttl NEVER self-evicts (fixes 2.5); rent state with `ttl: t` re-fetches after t. The per-key ttl is also the harness's TTL seam. |
| D-2.13 | **State-machine convention is canonical:** `(stateTransformers, payload, {sourceId})`. eventMap registration and cluster wrapping must preserve it; base-shape callers of a state machine's `streamEvents` are the bug. |
| D14 | **Registry-key NX claim** (owner chose the stronger option over the pin-only recommendation): an owner asserts `SET owner:<key> <machineId> NX` at connect; a second claimant fails loudly. This ADDS a RED spec test ("second owner must fail to connect/claim") alongside the I-O1 divergence pin, and is new specified behavior to implement. |

Consequences for the plan: the §4 "blocked" list is fully unblocked — transfer
receive-side invariants I-T1–I-T5 test against durable-ack/rollback semantics;
strategy-specific hydration tests target lazy read-through (cold-key read consults
Redis; hydration marker distinguishes absent from unhydrated); delete return-value and
HDEL tests use the D-Delete contract; the 3.4 reconnect leg asserts flush-on-reconnect;
2.5's fix direction is per-key ttl (owner-no-expiry), not rename; and D14 adds one new
RED test to the 3.6 suite.

### Original decision framing (for the record)

| # | Decision | Options / recommendation | Unblocks |
|---|---|---|---|
| D-Hydration | 3.2 strategy: eager-at-connect / lazy owner read-through / explicit `recover()` | **Recommend lazy (S2)** — fixes divergence at the defect site, no key-enumeration problem | Full recovery suite; shapes 2.5/2.6 fixes |
| D-Transfer | 3.1 "step 4" cluster: dispatcher post-ack action; ack-before-vs-after durability; who pends in-flight messages; ownership during window; timeout rollback + idempotent retry; transfer of durable-but-evicted state | Rollback-on-timeout + durable ack + router-side pending are the self-healing combination | Entire receive-side suite (I-T1–I-T5); real contracts for 2.4/2.8/2.12 fixes |
| D-Delete | 3.3: `set(null)` vs first-class `del`; flag algebra symmetry; HDEL field semantics; return value | Symmetry with existing write algebra; field-level HDEL required for hash coherence | Return-value + HDEL tests (I-D1/I-D2 proceed regardless) |
| D-2.7 | Is dropped fire-and-forget replication an accepted tradeoff? | Minimal invariant proposed: one post-recovery write reconciles | Whether 2.7 is a bug-fix target or a documented tradeoff |
| D12 | Replica reconnect cache policy | **Recommend flush LRU on cachedChannel reconnect** | Reconnect leg of 3.4 |
| D13 | Dead config surface: delete `local`/`refresh`/`useShard`/`localStore`; **specify per-key `ttl`** | ttl directly remediates the 2.5 data-loss finding AND is the harness's TTL seam | TTL-expiry variants of 2.5/2.12; removes future test obligations |
| D-2.13 | Canonical handler contract (state-machine convention vs base) | Recommend the state-machine convention | 2.13-A's spec direction |
| D14 | Ownership-conflict detection (none / registry-key `SET NX` / write fencing) | Lowest urgency (per-service use case); I-O1 pin proceeds without it | The RED "second owner fails" test |

Also queued for the audit: addenda A1/A2 (§0), and the `getHash` missing-key `{}`-vs-
`null` wart.
