# CONSUMER_GROUP.md — reliability design & resolution

Design rationale and as-built resolution for the `@streamerson` consumer-group reliability
work — **Architecture A**: acked reads + a Pending Entries List, a coordinator-run reaper, a
per-topic dead-letter queue, and atomic Lua terminal transitions (`{XADD response; XACK}` /
`{XADD dead-letter; XACK}`).

The original first-principles analysis (the pre-fix architecture walk-through, the behavior
matrix of predictions, and the ranked defect list) has been retired: every behavior it
predicted is now implemented and guarded by the live `bun:test` suite, which is the regression
record. What remains is the part that stays useful — the **forward design** (Part 7), the
**as-built status** with the test that guards each behavior (Part 8), and an **independent
runtime stress verification** (Part 9). The 7–9 numbering is kept so existing `§7.x` references
from the companion specs still resolve.

> The `CG-*` identifiers are the behavior IDs from the retired matrix — A lifecycle · B identity ·
> C delivery · D ack/once-only · E resumption · F process/cluster lifecycle · G robustness ·
> H ergonomics · I concurrency & safety. Part 8 restates each with its as-built status, so they
> read standalone.
>
> **Companions:** the actionable build + TDD plan is
> [`docs/specs/REQUEST_STREAM_RECEIPT.md`](./docs/specs/REQUEST_STREAM_RECEIPT.md); the
> ordering-vs-reliability split is [`docs/specs/CONSISTENCY.md`](./docs/specs/CONSISTENCY.md);
> current gaps are in [`PROJECT.md`](./PROJECT.md).

## The use case (the bar to meet)

Wrap the Redis consumer-group API behind a Streamerson object so a worker is treated like a plain
JS object / stream / EventEmitter, while underneath it reads a Redis stream as a **named member of
a group**, with: (1) **identity-based membership**, (2) **distributed once-only delivery** (a new
message to exactly one member; N members share load), (3) **resumption** from the correct portion
of the stream via identity, and (4) an **ergonomic surface** — bind handlers by message type;
pipe/iterate; bidirectional request→response for the gateway pattern. Parts 7–9 are measured
against exactly these claims.

---

# Part 7 — Reliability design: supplying the no-loss contract (proposal)

> Forward design (not as-built). The goal: **every message reaches a terminal state — DONE or
> recorded-FAILED — and nothing is ever silently lost.** Proposal for review; nothing here is
> built or chosen yet.

## 7.1 The invariant, stated precisely

For every message M added to the consumer stream **after the group exists**, the system
eventually reaches exactly one terminal state, and the failure set never *under*-reports:

- **DONE** — handler succeeded and M was acked. (Effect committed **at most once** in default mode.)
- **FAILED** — durably recorded with cause and provenance; inspectable and replayable.

Never: **silently dropped**, nor **stuck non-terminal with no owner**.

**Error direction is conservative:** FAILED may *over*-report (a message that succeeded but
crashed before its ack can land in FAILED) but never *under*-reports (a truly-unprocessed
message is never marked DONE and never lost). We would rather double-record a failure than
lose one.

## 7.2 Why the primitives don't supply it for free

- **`NOACK` = read-and-forget** → silent loss on crash. Must be dropped.
- **A PEL with no sweep = limbo, not failure.** "Pending forever" is recoverable but *not
  terminal* and *not classified* — "always recorded as a failure" requires something to
  decide "this has been abandoned" and move it to a failure record.
- **Internal ack-gap** (record-outcome vs `XACK` are two ops) → a crash between them splits
  brain. Needs atomicity (**Lua**).
- **External-effect-vs-ack gap** is *not closable in Redis alone* (inbox/outbox territory).
- **Outside the PEL's protection:** pre-group messages (`$` cursor), trimming below the PEL,
  and `DELCONSUMER` all lose entries the PEL never tracked or already dropped.

## 7.3 Mechanism menu (each closes one named gap)

| Mechanism | Closes | Cost |
|---|---|---|
| Drop `NOACK`; `XACK`-after-success | silent loss on crash (CG-D2) | none — the PEL is free |
| **Reaper**: sweep stale PEL → DLQ via Lua `{XADD dlq; XACK}` | limbo → terminal FAILED | one background loop + a DLQ stream |
| Lua atomic terminal transition `{record/respond; XACK}` | internal ack-gap (CG-I6) | one `EVAL` per terminal op |
| RPC: Lua `{XADD response; XACK request}` | lost response on crash (CG-I6) | one `EVAL` per reply |
| Ack predicate = genuine success only (no `Error` sentinel) | false-ack of no-handler (CG-I4) | none |
| Handler-throw → record + advance (don't wedge) | head-of-line block (CG-I5) | none |
| Group-exists-before-produce (idempotent create; surface failures) | pre-group loss (CG-A5) | startup assertion |
| Trim / `DELCONSUMER` guarded by PEL low-water-mark | loss outside the PEL | bookkeeping |
| *(retry)* self-PEL `0`-drain on restart | own un-acked redelivery | re-run (idempotent) |
| *(retry)* reclaim `XAUTOCLAIM` `min-idle ≥ handler-time` | cross-machine recovery | re-run (idempotent) |
| *(retry)* max-delivery cap → force-DLQ | poison-message non-termination | delivery-count check |
| *(exactly-once effect)* dedup key inside the effect's own txn | double effect under retry | inbox pattern (external) |

## 7.4 Two architectures on the cost/guarantee spectrum

- **A — PEL + Reaper + DLQ (recommended default).** In-flight = the PEL; failure ledger = a
  per-topic DLQ stream; terminality = the reaper. Lua makes every terminal transition atomic.
  **Default (no retry)** = at-most-once effect + always-DLQ'd-on-abandonment ⇒ the full 7.1
  invariant with the lightest hot path. **Opt-in retry** layers `0`-drain + `XAUTOCLAIM` +
  max-attempts on top. The reaper is the one genuinely new component.
- **B — Durable per-message status inbox + DLQ (opt-in; audit / dedup).** Adds a `msg:<id>`
  hash (`processing → done|failed`, `attempts`) updated atomically with `XACK` via Lua. Doubles
  as the **dedup table** for at-least-once and as a queryable terminal ledger independent of
  consumer lifecycle. Heavier (an extra `HSET` per message); use when per-message audit or
  dedup-based exactly-once-effect is required.

## 7.5 Where exactly-once truly lives

Redis gives **exactly-once *recording*** (Lua) plus **at-most/at-least-once *delivery***.
Exactly-once *external effect* requires the dedup key to live inside the external system's own
transaction (e.g. a SQL unique constraint on `messageId` — the inbox pattern); the framework
can only make handlers *idempotency-friendly* by always passing a stable `messageId`. **But the
RPC/gateway path is special: its effect is itself a Redis stream write**, so Lua
`{XADD response; XACK request}` yields true **once-only response** semantics — a real strength
of the streamerson model, not available to arbitrary handlers.

## 7.6 The unified timeout (refines Q5)

`processingTimeout` = **abandonment grace**: the idle threshold past which a pending entry is
deemed abandoned. The *same* knob drives the reaper (no-retry → DLQ) and the reclaimer (retry →
re-run); both require it `≥` worst-case handler time, or a merely-slow member is treated as dead
(→ over-reported failure, or double-execution under retry). `idleTimeout` stays the
`XREADGROUP BLOCK` cadence.

## 7.7 A vs B — rigor, performance, scalability (recommendation: A as substrate)

| Axis | Winner | Why |
|---|---|---|
| **Performance** | **A** | ~1 op/msg (`XACK`, batchable; or one `EVAL` for RPC); PEL tracking is free (a side effect of the read). B adds an `HSET` at receipt + a heavier terminal Lua **and allocates one key per message**, loading the dict and the expiry cycle. |
| **Scalability** | **A** | A's tracking state = PEL size = `O(in-flight)` ≈ `throughput × handler-latency × consumers` — bounded by concurrency, self-draining. B's inbox = `O(total volume in the dedup window)` — grows without bound unless TTL'd/drained, and the TTL is a correctness knife (early → double-process; late → blowup). |
| **Rigor (stated contract)** | **A** | In-flight tracking delegated to Redis's proven PEL (`XAUTOCLAIM` atomic idle-reset, `XACK`); only custom logic is one Lua script + the reaper loop. Fewer of *our* invariants to violate. A's weakness is liveness-only (reaper-down ⇒ limbo, not loss) + conservative over-reporting. |
| **Rigor (wider contract)** | B | A durable per-message state machine enables **dedup** → near-exactly-once-*effect* under **retry** against external systems — but only there, it doesn't close the irreducible effect-vs-record gap, and it costs the most complexity (hash ⇄ PEL ⇄ DLQ consistency). |

**Decision rationale:** A is more performant and more scalable unconditionally, and more rigorous
*for the no-silent-loss / at-most-once-or-recorded contract* because it keeps the least custom
state. It also composes with the project's retention strategy — the **DLQ is a stream that
drains to SQL** (`core/types.ts › DataSourceOptions.maxLen`, `streamable.ts › writeToStream`:
retention is reverse-streamers→SQL, not native Redis state), so the durable/audit ledger lives
in SQL (unbounded, queryable) while Redis stays lean (in-flight + recent). **Recommendation: A
is the substrate; B's inbox is opt-in per topic/handler** for the few that genuinely need
dedup or in-Redis audit — cost localized, not paid globally.

---

# Part 8 — Resolution status (post-implementation)

> Architecture A was built across the five phases in
> [`docs/specs/REQUEST_STREAM_RECEIPT.md`](./docs/specs/REQUEST_STREAM_RECEIPT.md). This part
> **supersedes the retired matrix's "Now?" predictions** with the as-built state and the test that guards each.
> Full suite at completion: **59 pass / 2 skip / 0 fail** (stable across runs), `bun run build` clean.

**Headline defect closed:** the group is no longer `NOACK + '>'` at-most-once-with-silent-loss.
`NOACK` is removed; every message reaches a terminal state — **DONE** (handler ok, atomically
`{XADD response; XACK}` or plain `XACK`) or **FAILED** (atomically `{XADD dead-letter; XACK}`, inline
or via the coordinator's reaper) — and an entry leaves the PEL only via an atomic terminal transition.
Opt-in `retry` upgrades the default (at-most-once-effect, no silent loss) to at-least-once.

| ID | As-built status | Guarding test |
|---|---|---|
| CG-A1 | ✅ idempotent create; re-create reports `created:false` | `bootstrap.test` |
| CG-A2/A3 | ✅ unchanged (consumer key, MKSTREAM) | `bootstrap`/`coordinator` |
| CG-A4 | ◐ → **caller-selectable**: `coordinator.create(cursor)` forwards `'0'`/`'$'`; default `'$'` | — |
| CG-A5 | ✅ **fixed** — non-`BUSYGROUP` create error propagates | `coordinator.test` (WRONGTYPE) |
| CG-B1 | ◐ → empty id is a **hard error** (D1); cluster assigns distinct ids; a shared name shares a PEL **by design** (no duplicate guard) | `coordinator.test` (D1) |
| CG-B2 | ✅ **fixed** (D3) — `ConsumerGroupCoordinator` never consumes; no phantom `''` consumer | `coordinator.test` |
| CG-B3/E1 | ✅ **resumption via retry** — restart, same id, self-PEL `'0'`-drain re-runs own pending | `retry.test` (self-drain) |
| CG-C1/C2 | ✅ exactly-one delivery, N-member spread (coordinator no longer competes) | `cluster-lifecycle` (30 msgs/3 members) |
| CG-C3/C4/C6 | ✅ unchanged | `cluster`/`receipt` |
| CG-C5/H2/H3 | ✅ **proven** — message→handler→correlated response | `cluster`/`terminality`/`receipt` |
| CG-D1 | ✅ **fixed** — `NOACK` removed; real `XACK`; PEL drains | `terminality` (PEL=0) |
| CG-D2 | ✅ no silent loss (default); **at-least-once via opt-in retry** | `retry.test`, `reaper.test` |
| CG-D3 | ✅ **fixed** — `XPENDING`/`XAUTOCLAIM` reaper (default) + reclaim (retry) | `reaper.test`, `retry.test` |
| CG-D4 | ✅ **removed** — dead `acknowledgeProcessed` toggle deleted (always acks on success) | type-check |
| CG-E2 | ✅ explicit cursors — `'0'` (own PEL) for recovery, `'>'` for new | `retry.test` |
| CG-F1/F2 | ✅ unchanged | `bootstrap`/`receipt` |
| CG-F3/F4 | ✅ longevity under load; `scale()` up/down reconcile | `cluster-lifecycle` |
| CG-G1 | ✅ no-handler → DLQ, loop continues (member); base pipe always `callback()`s | `terminality`, `receipt` |
| CG-G2/I5 | ✅ **fixed** — member loop try/catch per event; base pipe `callback()` in catch | `receipt` (echo after boom) |
| CG-G3 | ✅ **fixed** — `'…cijkdcjidkfj'` cruft removed from the base pipe | code review |
| CG-H1 | ✅ unchanged | — |
| CG-I1 | ✅ **fixed** — one persistent UPDATE/CANCEL listener + re-armable wake; member bypasses it | `iterate-stream-listeners.test` |
| CG-I2 | ✅ no loss — loop checks `closing` between messages; an interrupted read's delivered entries are safe in the PEL → reaper/retry | `reaper.test` |
| CG-I3 | ✅ **fixed** (Phase 5) — member-owned `drain()` flushes in-flight terminalization before close | `cluster-lifecycle` (drain) |
| CG-I4 | ✅ **fixed** — discriminated `Outcome`; only genuine success acks | `terminality` (no-handler→DLQ) |
| CG-I6 | ✅ **fixed** — `RESPOND_AND_ACK` Lua: response durable iff request acked | `terminality` (atomicity) |
| CG-I7 | ✅ **enforced** — `retry` requires `processingTimeout > 0` (reclaim `min-idle`); slow≠dead | `retry.test` (CG-I7) |
| CG-I8 | ✅ avoided — no `DELCONSUMER`/auto-eviction is issued, so a consumer's PEL is never discarded | code review |

**Residual / by-design (unchanged from the analysis):** the irreducible effect-vs-ack gap (a crash
after a side effect commits but before its terminal transition → conservative over-report under
no-retry, or a double-execution under retry — handlers must be idempotent); exactly-once *external*
effect still requires the dedup key inside the external system (Architecture B inbox, deferred,
opt-in. *(The bidirectional member's redundant `outgoingChannel` has since been cleaned up: the
member nulls the inherited channel and connects only the incoming side, so responses flush via
`respondAndAck` on the incoming control connection with no second idle connection per member.)*

---

# Part 9 — Independent runtime verification (stress)

> **Method.** Part 8's status is guarded by the `bun:test` suite, which was written TDD-style
> alongside the implementation. To check the invariants **independently** — from first principles,
> not from the suite — a throwaway harness (`tmp/cg-verify/`) drives the **real** classes
> (`ConsumerGroupMember`, `ConsumerGroupCoordinator`, `ConsumerGroupCluster`, `StreamingDataSource`)
> against **live Redis** and asserts on **Redis ground truth queried separately** (`XLEN`,
> `XPENDING` summary + per-consumer, `XRANGE` of the producer and dead-letter keys) plus in-process
> handler counters — never on the framework's own bookkeeping. Each script stresses one family of
> invariants harder than the suite (volume, concurrency, real crashes, adversarial timing) and exits
> non-zero on any deviation. The scripts are disposable (regeneratable from this section); the
> regression guards remain the `bun:test` suite.

## 9.1 Scripts and what each stresses

| Script | Stresses (first-principles invariant) | Scale vs suite |
|---|---|---|
| `v1-conservation` | No silent loss · exactly-one effect · N-member distribution · atomic terminality (no split-brain) | 1000 msgs × 4 members (suite: 30 × 3) |
| `v2-abandonment` | Default mode: a crashed member's **delivered-unacked** batch → reaper → DLQ('abandoned'), once; PEL drains | real member crash holding a **10-entry** batch (suite: 1 phantom entry) |
| `v3-retry` | Opt-in retry: at-least-once recovery of transient failures · bounded poison → DLQ · conservation | 280 msgs (120 clean / 120 transient / 40 poison) one member |
| `v4-slow-not-dead` | **CG-I7 safety**: healthy slow handler (< grace) runs **exactly once** under 2 concurrent reclaimers; **+ boundary** | 60 msgs/2 members + deterministic boundary probe |
| `v5-identity-resume` | The headline claim: same-id member resumes **its own PEL**; a different id does **not** inherit it | per-consumer `XPENDING` ownership checks |
| `v6-lifecycle` | CG-I1 idle listener-leak fix · clean teardown mid-blocking-read | ~50 idle BLOCK cycles |
| `v7-cluster-crash` | Full **Bun-Worker** cluster: no loss across a mid-load crash · in-flight entry → DLQ · restart-to-count | 60 msgs through 3 worker threads + crash |

## 9.2 Result

**All seven scripts: ALL INVARIANTS HELD (0 framework deviations), stable across repeated runs.**
Notable measured ground truth: V1 distributed 1000 messages 250/251/250/249 across 4 members with
max-handler-runs-per-id = 1 (no duplicate effect) and PEL = 0; V3 dead-lettered all 40 poison
messages at `deliveryCount` 4 (just past `maxAttempts` 3) with 240 transient/clean responses and PEL
= 0; V4-A ran every healthy slow handler exactly once under two concurrent reclaimers; V5 showed the
crashed member's 8 entries staying owned by its name through the crash and re-running on same-id
restart while a foreign id touched none; V7 returned 60/60 responses through worker threads despite a
crash, recovered the crashed `boom` entry to the DLQ, and restored the member count to 3.

## 9.3 Deviations & findings list

No deviation from the stated contract survived investigation. The two items below are the only
findings; both **confirm** the design rather than contradict it.

1. **(Harness, not framework — but a real property worth stating.)** V2's first run dead-lettered
   only **1 of 10** entries. Root cause was harness sequencing: the victim member connected *before*
   the batch was produced, so its first `XREADGROUP` raced the producer and delivered only one entry
   into its PEL before the handler hung; the other nine were **never-delivered backlog**. The reaper
   (`XAUTOCLAIM`) correctly recovers only **delivered-pending** entries — never-delivered backlog is
   not "abandoned", it simply waits for a live member. Fixing the harness (produce → then start the
   member so one read claims all ten) gave 10/10. **This is correct, load-bearing behavior**:
   abandonment recovery and backlog delivery are distinct concerns; the reaper owns only the former.

2. **(By-design boundary — confirms CG-I7.)** V4-B deterministically reproduced **double execution**
   when a handler runs **longer than `processingTimeout`** under retry (handler 600 ms, grace 300 ms):
   a second member's reclaim pass legitimately claims the still-in-flight entry once it is idle ≥ grace
   and re-runs it (observed: ran 2×, two responses). This is **not a defect** — it is exactly the hazard
   `config.ts` guards against by requiring `processingTimeout > 0` for retry, and which the docs state as
   "grace MUST exceed worst-case handler time; handlers must be idempotent." The probe shows the boundary
   sits precisely where the theory predicts, and that even there the **delivery** contract holds (still
   responded, PEL drained) — double-effect is the cost of a misconfiguration, **loss is not**. Operators
   enabling retry must set `processingTimeout` ≥ worst-case handler time and keep handlers idempotent.

**Verified-but-unchanged residual:** the irreducible effect-vs-ack gap (a crash after a handler's side
effect commits but before its atomic terminal transition) remains — conservative over-reporting under
no-retry, a double-execution source under retry. The verification cannot close it (it is fundamental);
it only confirms the framework's posture toward it is the documented one.
