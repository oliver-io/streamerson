# Gateway response-reader self-heal — concurrency model & spec

> **Status:** design, pending sign-off. Implements the resolved Q1 (GW9 self-heal + "freeze
> time") and Q9 (GW15 resumable cursor) decisions in
> [`../todo/FASTIFY_GATEWAY_OPEN_QUESTIONS.md`](../todo/FASTIFY_GATEWAY_OPEN_QUESTIONS.md).
>
> **Why this doc exists:** reconnection logic layered over a streaming request/response
> correlation is a race minefield. Per the owner's instruction, the asynchronicity is modeled
> and every interleaving stress-tested *before* a line of reconnection code is written. The
> goal is a proof, not a hope, that we add **no** new race or undefined behavior to in-flight
> requests/responses.

## 0. Scope

- Covers the **read / response** path of a gateway awaiter (`streamAwaiter` / `StreamAwaiter`
  in `packages/core/src/deferral/stream-awaiter.ts`) and the `DeferralTracker` it owns.
- The **write** path is explicitly out of scope: `dispatch` writes on a *separate*
  `writeChannel`; a write failure already rejects the dispatch and is not "in flight."
- Single Redis logical instance; per-binding awaiters are independent (no shared mutable
  state across bindings except the OS/Redis connection count).

## 1. Async agents (who runs concurrently)

All run on one JS event loop — never truly parallel; they interleave **only at `await`
points**. That single fact is the backbone of every resolution below.

| # | Agent | What it does |
|---|---|---|
| **A1** | HTTP handlers (many) | each: `promise(id)` → `writeToStream` (writeChannel) → `await $expectedResponse` → `finally delete(id)` |
| **A2** | Response reader (one) | a flowing `Readable` from `getReadStream`→`iterateStream`; `onData(e)` → `stateTracker.emit('response', e)` |
| **A3** | `DeferralTracker` emitter | `'response'`→`responseEvent` (sync), `'error'`→`errorEvent` (sync) |
| **A4** | Self-heal loop (new, one) | on reader `'error'`: suspend → reconnect-with-backoff → re-arm → resume |
| **A5** | Teardown | disposer + gateway `onClose`: stop loop, detach, disconnect channels |
| **T** | Timers | per-deferral dispatch timeout; orphan self-delete (`timeout*2`); backoff |

## 2. Shared mutable state

- `DeferralTracker.promises: Record<id, {self, resolve, reject, timeout, timeoutMs}>` — the
  correlation map. (`timeoutMs` is **new** — see §8.)
- `lastCursor` (new, awaiter-local) — id of the last **delivered** producer entry.
- `readChannel._client` — swapped by `reconnect()`.
- `suspended` (new, tracker flag), `healing`/`disposed`/`attempts` (new, loop flags).

## 3. Lifecycle state machine (per awaiter)

```
            armed + tip captured (AWAITED before serving — §9, closes cold-boot)
   ┌──────────────────────────────────────────────────────────────────┐
   ▼                                                                    │
HEALTHY ──reader 'error' (non-intentional)──▶ HEALING                   │
   ▲                                              │                     │
   │                                              │ suspendTimeouts()   │
   │                                              ▼                     │
   │                                    backoff(attempts++)             │
   │                                              │                     │
   │                          ┌───────────────────┴──────────┐          │
   │              reconnect() ok                    reconnect() fails    │
   │                          │                                │         │
   │                  re-arm from lastCursor          (loop, backoff)    │
   │                  resumeTimeouts()                         │         │
   └──────────────────────────┘                    attempts≥max? ──yes──┤
                                                               │         │
                                                               no        ▼
                                                            (loop)   cancelAll('reader
                                                                     unavailable') → 503
   DISPOSED: set by A5 at any point; loop bails after its current await; disconnect
   happens-after the loop exits (§7/R4).
```

## 4. Cursor model (Q9) — loss-free, resumable

- **First arm:** seed from a **captured concrete tip** (`XREVRANGE producer + - COUNT 1`,
  i.e. the existing private `lastGeneratedId`), *not* `'$'`. `'$'` re-resolves to the live tip
  at each first read, silently dropping anything in the arm-up window.
- **Steady state:** `lastCursor = event.streamMessageId`, committed in `onData` **after** the
  `'response'` emit (process-then-commit).
- **Re-arm:** `getReadStream({ stream, last: lastCursor ?? capturedTip })`. `XREAD` is
  **exclusive** of `last`, so:
  - delivered entries (id ≤ `lastCursor`) are **never** re-read → no duplicate;
  - entries written during the outage, or read-ahead-buffered-but-undelivered when the error
    hit (id > `lastCursor`) are re-read → **backlog recovered**.
- `'0'` is rejected: it would replay the entire producer history on every boot/re-arm.

## 5. "Freeze time" model (Q1) — `DeferralTracker.suspendTimeouts()` / `resumeTimeouts()`

- A dispatch timeout exists to bound **server processing**. During an infra read-outage the
  wait is unrelated to the worker, so the timeout is meaningless and would wrongly fail a
  request that *will* succeed on recovery.
- **suspend** (state, set on HEALTHY→HEALING): `clearTimeout` every armed deferral timer
  **without rejecting**; while suspended, a new `promise(id)` registers but does **not** arm
  its timer.
- **resume** (on recovery, before backlog `'data'`): re-arm every still-pending **real**
  deferral (`resolve !== noOpFunction`, §R5) with a **fresh full** `timeoutMs` (grace measured
  from recovery).
- Termination of a frozen wait is therefore exactly one of: (a) a response arrives, (b) the
  client disconnects (§R8), (c) give-up `cancelAll` → 503. The dispatch-timeout path is
  *paused*, not removed.

## 6. The quadruple-check — race table

Each row: the interleaving, the risk, and the **invariant** that neutralizes it.

| # | Interleaving | Risk | Resolution / invariant |
|---|---|---|---|
| **R1** | A1 (`promise`/`delete`) interleaves with A3 (`responseEvent`) on `promises` | torn read/write of an entry | Single-threaded + **synchronous** `emit` + flowing-mode `'data'` delivered one-at-a-time ⇒ `responseEvent` calls serialize; A1 touches the map only at non-await points. **Invariant:** never `await` between reading `promises[id]` and mutating it. |
| **R2** | reader `'error'` after delivering E but before E+1; re-arm | **duplicate** or **skipped** response | Re-arm is **exclusive** from last *delivered* id. Delivered ≤ `lastCursor` never re-read (no dup); undelivered/buffered > `lastCursor` re-read (no loss). **Invariant:** `lastCursor` is committed for every event whose `'response'` was emitted, before the next read can throw. |
| **R3** | response arrives around suspend/resume | spurious timeout, or resume races a response | Order is suspend→reconnect→re-arm→**resume (sync)**; the new stream's first `'data'` needs an async `XREAD`, so resume *happens-before* any backlog data. resume is idempotent over real deferrals. **Invariant:** resume happens-before re-armed `'data'`. |
| **R4** | A5 (dispose/`onClose`) during A4 (healing) | `reconnect()` and `disconnect()` interleave on `_client` (live client after close = leak/UB) | `disposed` checked after **every** `await` in the loop; backoff delay races a dispose signal; **`channel.disconnect()` happens-after the loop exits** (teardown awaits loop completion). **Invariant:** no `reconnect()` after `disposed`; disconnect strictly after loop end. |
| **R5** | orphan pre-store entries (`responseEvent`/`errorEvent` else-branch, `timeout*2`, noop resolve) | resume re-arms a phantom; double-timer | suspend/resume act only on **real** deferrals (`resolve !== noOpFunction`); orphans self-delete. For the gateway flow orphans never occur (deferral-before-write + exclusive re-arm). **Invariant:** resume skips non-real entries. |
| **R6** | new dispatch during outage | inconsistency between frozen and new requests | writeChannel ⟂ readChannel. Write ok ⇒ deferral frozen, resolves from backlog. Write fails (full outage) ⇒ dispatch rejects fast (write-path resilience is out of scope). **Invariant:** self-heal never touches the write path; freeze applies only to already-written in-flight requests. |
| **R7** | `reconnect()` vs reads/writes/listeners | disrupt a write; leak `keyEvents` listeners; dirty `streamIdMap` | Awaiter reads only on readChannel, writes only on writeChannel ⇒ reconnecting readChannel can't disrupt writes. `iterateStream`'s `finally` removes its UPDATE/CANCEL listeners on error; re-arm starts fresh; `addStreamId` is idempotent. **Invariant:** read/write channel separation; bounded per-stream listener lifecycle. |
| **R8** | client disconnects while its request is frozen | frozen deferral for a gone client leaks for the whole outage (unbounded with `maxAttempts=∞`) | `dispatch` accepts an **`AbortSignal`**; the gateway wires `request.raw` close → abort → `cancel(id)`. **Invariant:** every in-flight deferral has a termination path = response ∨ client-abort ∨ give-up; only the dispatch-*timeout* is suspended during an outage, not the abort path. |
| **R9** | fast first request before the reader is armed | cold-boot `'$'` gap (GW15) | Arming (tip capture + `getReadStream`) is **awaited** inside the plugin body so `ready()` blocks on it; reader seeds from the captured tip. **Invariant:** reader armed + tip captured *happens-before* serving. |
| **R10** | Redis flaps (PING ok, `XREAD` drops) with `maxAttempts` set | tight reconnect loop / never give up | `attempts` resets only on a **real delivery** (proven-healthy), so `maxAttempts` bounds attempts since the last delivery; backoff grows across flaps. Default `maxAttempts=undefined` ⇒ infinite, never 503. **Invariant:** give-up only when `maxAttempts` set and exhausted-since-last-delivery. |

## 7. Teardown ordering (the R4 invariant, spelled out)

`onClose` must: (1) set `disposed = true` and signal the loop's backoff to abort; (2) **await
the self-heal loop's termination**; (3) detach the current reader's listeners; (4)
`disconnect()` the channels. Steps (2)→(4) ordering is what prevents an in-flight
`reconnect()` from resurrecting a client after `disconnect()`. ⇒ the awaiter must expose an
**awaitable** teardown (not just the current sync `() => void` disposer), or track the loop
promise for `onClose` to await.

## 8. Knock-on changes the model forces

- **`ResponseTracker` gains `timeoutMs`** — stored per entry so (a) Q6 per-route timeout is
  honored and (b) resume re-arms each deferral with *its own* effective timeout.
- **`promise(id, timeoutMs?)`** — optional per-call timeout (Q6) and suspend-aware (no arm
  while suspended).
- **`dispatch(..., opts?: { signal?: AbortSignal })`** — client-disconnect cancellation (R8).
- **Awaited arming in the plugin** — registration blocks until readers are armed + tips
  captured; if Redis is down *at boot*, registration fails loudly (self-heal is for runtime
  drops, not boot). Replaces today's fire-and-forget arming loop.

## 9. New surface (for sign-off)

| Layer | Addition |
|---|---|
| `StreamingDataSource` (transport) | `reconnect()` (close dead client(s), fresh `make()`+`connect()`, clear `closing`); a public current-tip read (wrap `lastGeneratedId`) |
| `DeferralTracker` (correlation) | `suspendTimeouts()` / `resumeTimeouts()`; `promise(id, timeoutMs?)`; per-entry `timeoutMs` |
| awaiter (policy) | self-heal loop + `reconnect` options; `dispatch(..., {signal})`; awaitable teardown; `readResponseStream` seeds from captured tip & tracks `lastCursor` |
| gateway plugin | await arming; thread `reconnect` opts; wire `request` close → `AbortSignal`; map give-up rejection → **503** |

`reconnect?: { baseMs?, maxMs?, factor?, maxAttempts? }`; default `maxAttempts` undefined =
infinite reconnect + freeze; set = give-up → 503.

## 10. Test plan (RED first, real Redis)

1. **cursor-resume / backlog survives an outage** — dispatch, drop the read connection
   mid-flight, write the response during the outage, restore; assert the request resolves with
   that response (proves §4 re-arm-from-`lastCursor`, not `'$'`).
2. **freeze, no spurious timeout** — short dispatch timeout; induce an outage longer than the
   timeout; assert the in-flight request does **not** time out during the outage and resolves
   on recovery (proves §5).
3. **no duplicate delivery** — success, then force a re-arm; assert the resolved request's
   deferral isn't re-touched and no orphan entry appears (proves R2/R5).
4. **give-up → 503** — `maxAttempts` small, permanent outage; assert pending reject (mapped
   503) after the cap, not before (proves R10 + §5 give-up).
5. **client abort releases a frozen wait** — freeze a request, abort the client; assert the
   deferral is cancelled and the map returns to baseline (proves R8).
6. **dispose during healing** — induce an outage, `close()` mid-reconnect; assert no leaked
   connections and no post-close `reconnect()` (proves R4/§7).
