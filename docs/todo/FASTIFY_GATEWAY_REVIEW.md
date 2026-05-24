# Fastify Gateway — First-Principles Review (findings for review)

> **Scope.** `@streamerson/gateway-fastify` (v0.0.21) — the single exported factory
> `CreateGatewayPlugin` in `packages/gateway-fastify/src/stream-plugin.ts`, its public
> type surface (`src/types.ts`), and the request lifecycle it stitches together through
> `@streamerson/core` (`streamAwaiter` / `DeferralTracker` / `StreamingDataSource`). The
> worker side (`@streamerson/consumer`) is in scope only where its behavior is *observable
> through the gateway* (e.g. how a handler error surfaces to an HTTP client).
>
> **This is a review, not a fix log.** Nothing here has been changed. Each item records
> what was observed, the evidence, why it is a defect/risk, and a proposed direction —
> for discussion before any code is written (per CLAUDE.md: spec-first, no unilateral
> changes).
>
> **Method.** First-principles contract → reproduction against a live worker + real Redis
> over **real HTTP** → observation. Throwaway probes live in `tmp/gateway-probe/`
> (`gateway-probe.ts` = the 10-scenario harness, `extra.ts` = error-surface probes;
> regeneratable, not committed). Confidence is labeled per finding: **[verified]** =
> reproduced and observed; **[code]** = established by reading the code path, not forcibly
> reproduced.

## The use case (what this is *for*)

Terminate HTTP at the edge; carry the interior over Redis Streams. The gateway is the
HTTP→stream half: an incoming request body is written (`XADD`) to a topic's **consumer**
stream; a worker elsewhere consumes it, runs a handler, and writes a response to the
topic's **producer** stream; the gateway correlates that response back to the waiting
HTTP request **by `messageId`** and replies. The HTTP layer does no business logic and
never calls another service directly. Fastify (not `Bun.serve`) is deliberate: it gives
users a real plugin model so stream-backed routes can be mixed into an existing Fastify
app. The intended lifecycle:

```
fetch ─POST /x─▶ route handler ──dispatch()──XADD──▶ [CONSUMER stream] ──▶ worker
                      ▲                                                       │ handler
   reply.send ◀───────┘   DeferralTracker correlates by messageId            ▼
                      └──── .on('data') ◀─XREAD─ [PRODUCER stream] ◀──XADD────┘
```

This core path **works and is well-shaped** (see "What works"). The findings below are
about everything around it: request fidelity, failure surfaces, lifecycle, and config.

## Findings at a glance

| ID | Finding | Severity | Confidence | Primary location |
|----|---------|----------|-----------|------------------|
| **GW1** | Only `request.body` is forwarded — query/path params and headers are dropped | **High** (functional) | verified | `stream-plugin.ts` handler |
| **GW2** | Documented "fire-and-forget" mode does not exist | **High** (feature/doc gap) | verified | `stream-plugin.ts` handler; README |
| **GW3** | All worker failures collapse to one opaque `500` "timed out" (and cost the full timeout) | **High** (observability/correctness) | verified | handler + consumer pipe + DeferralTracker |
| **GW4** | No Redis auth/TLS/db config — only `host`/`port` are plumbed | **High** (deployment) | code | `getStreamAwaiter` + `DataSourceOptions` |
| **GW5** | No `onClose` teardown — 4 Redis connections per topic leak on every `server.close()` | **High** (resource leak) | verified | plugin body (no hook) |
| **GW6** | Per-route `timeout` is silently ignored (only plugin-level honored) — and the shipped example sets it | Medium (doc/behavior) | verified | `getStreamAwaiter` uses `options.timeout` |
| **GW7** | A handler returning void/undefined → response dropped → timeout (no empty 200/204) | Medium (REST semantics) | verified | `getWriteStream` null-guard |
| **GW8** | `DeferralTracker` permanently leaks a `promises[id]` entry on every timeout — **✅ FIXED** | Medium (memory) | verified | `deferred-promise-tracker.ts` + `stream-awaiter.ts` |
| **GW9** | Response-reader is fire-and-forget with no `'error'` handler; a Redis hiccup → unhandled stream error → crash | Medium (robustness) | code | `stream-plugin.ts` `readResponseStream().catch(throw)` |
| **GW10** | `register({ prefix })` is ignored (fastify-plugin escapes encapsulation) | Low-Med (ergonomic) | verified | `fp(...)` wrapper |
| **GW11** | `.inject()` (light-my-request) crashes under Bun → plugin can't be black-box tested the standard way | Low-Med (testability) | verified | Bun × light-my-request `response._header` |
| **GW12** | Non-Fastify keys spread into `fastify.route(...)`; a user-supplied `handler` is silently overridden | Low (hygiene) | verified | `defaultedRoute` spread |
| **GW13** | `request.sourceId` is decorated to `''` and never populated — vestigial | Low (dead code) | verified | `decorateRequest('sourceId','')` |
| **GW14** | No validation that `messageType` is set per route; missing → guaranteed silent timeout | Low (DX) | code | handler casts `route.messageType as MessageType` |
| **GW15** | Startup `'$'` join race: a response in the reader's arm-up window is missed | Low (correctness, probabilistic) | code | `readResponseStream` default `'$'` (core F5) |

---

## Detail

### GW1 — Only `request.body` is marshaled; query/params/headers dropped · High · [verified]

The handler builds the stream message from the body alone:

```ts
// stream-plugin.ts
const response = await streamStateTracker.dispatch(
  JSON.stringify(request.body ?? {}),
  route.messageType as MessageType,
  request.sourceId,
);
```

`writeToStream` then carries only `{ messageId, messageType, incomingStream, messageSourceId, payload }`
on the wire. **Query strings, path params, and headers never reach the worker.**

- **Evidence (scenario 2):** `GET /item?id=42&q=hello` with header `x-trace: abc` → the
  worker's `payload` is `{}` (and `sourceId` is `""`). The id/query/headers are gone.
- **Why it matters:** For a *REST* gateway this is the central limitation. `GET /thing/:id`,
  `?page=2`, `Authorization`, idempotency keys, content negotiation — none are expressible.
  The CRUD example (`app-basic-crud`) has `GET /data` and `DELETE /data` routes with no way
  to pass an id except an unconventional GET/DELETE body.
- **Proposed direction (for review):** Define an explicit, documented request-envelope
  contract — marshal a structured `{ body, query, params, headers? }` (allow-listed,
  size-bounded) into the payload, or let a route opt into which parts to forward. Needs a
  spec: header allow-listing and size limits are security-relevant (don't blindly ship all
  headers onto a shared stream).

### GW2 — Documented "fire-and-forget" mode does not exist · High · [verified]

README: *"It can operate in a fire-and-forget mode (no call-and-response, just the call),
which allows this plugin to directly act as a RESTful producer-endpoint for an event
stream."* The code has **no such path** — the handler unconditionally
`await streamStateTracker.dispatch(...)` then `reply.send(response)`, and `dispatch` always
registers a deferral and awaits a correlated response.

- **Evidence (scenario 5):** With no worker, a request to a route just blocks to the
  timeout and returns `500`. There is no `awaitResponse: false` / `fireAndForget` option.
- **Why it matters:** A claimed headline capability is absent; a user wiring a pure
  event-producer endpoint will instead get a mandatory round-trip that 500s without a
  consumer.
- **Proposed direction:** Either implement a per-route `awaitResponse: false` (XADD then
  `202 Accepted`, no deferral registered) or remove the claim. The first is the smaller of
  the two gaps and matches the stated philosophy — propose as a spec'd route option.

### GW3 — All worker failures collapse to one opaque `500`, at full timeout cost · High · [verified]

Four distinct failure modes are indistinguishable to the client and each costs the **entire
timeout**:

| Cause | Worker-side behavior | Client sees |
|---|---|---|
| Handler throws | consumer transform `.catch` logs + `callback()` → skip; no response written | `500` after full timeout |
| Unregistered `messageType` | `process()` returns an `Error`; `getWriteStream` drops it (no `messageId`) | `500` after full timeout |
| Handler returns void (GW7) | `payload == null` → dropped by write guard | `500` after full timeout |
| No worker / worker down | nothing consumes | `500` after full timeout |

- **Evidence (`extra.ts`):** a handler that throws `handler-boom: invalid input` →
  `500 {"statusCode":500,"error":"Internal Server Error","message":"Request timed out after 0.5 seconds"}`
  at ~529ms. The real error string is nowhere in the response. Unregistered-type → byte-identical
  `500` at ~512ms.
- **Why it matters:** A worker-side validation error (a `400`-class condition that's known
  *instantly*) is reported to the client as a generic `500` only after the full timeout
  elapses — worst of both: wrong status, worst latency, zero diagnostics. This breaks the
  "transactional layer to users" promise.
- **Proposed direction:** Spec an error envelope on the **producer** stream — a worker
  failure writes a response carrying an error (status + message) with the same `messageId`;
  `DeferralTracker.errorEvent` already exists and would reject the dispatch promise, letting
  the handler map it to a real status. (Couples to the consumer package; spec jointly.)

### GW4 — No Redis auth/TLS/db configuration · High · [code]

`getStreamAwaiter` constructs channels with only host/port:

```ts
new StreamingDataSource({ logger, controllable: true,
  host: options.streamOptions?.redisConfiguration?.host,
  port: options.streamOptions?.redisConfiguration?.port })
```

`DataSourceOptions` (core `types.ts`) exposes no password/username/TLS/db — the only
injection point is `getConnection: () => RedisClient`, which `CreateGatewayPlugin` does
**not** surface. `RedisDataSource.redisUrl()` builds `redis://host:port` (never `rediss://`,
no AUTH).

- **Why it matters:** Effectively unusable against any managed/production Redis (Upstash,
  ElastiCache with auth/TLS, Redis Cloud). A blocker for real deployment.
- **Proposed direction:** Thread a `getConnection`/connection-options escape hatch through
  the plugin options (and ideally through core's `redisUrl()` for `rediss://`+AUTH). Small,
  high-value. Spec the option shape.

### GW5 — No `onClose` teardown; connections leak on `server.close()` · High · [verified]

The plugin opens two `StreamingDataSource`s per unique topic-binding (read + write), each
`controllable: true` (client **+** control connection) = **4 Redis connections per topic**,
and registers **no** `fastify.addHook('onClose', ...)`. Worse, the channels are captured
inside `getStreamAwaiter`'s closure and never exposed; the `readResponseStream()` disposer
(which would only `abort()` the read channel anyway — never `disconnect()`, never the write
channel) is discarded.

- **Evidence (scenario 7):** around one register→ready→close: `connected_clients` `30 → 34
  (+4) → 34` — the 4 are **not** released by `close()`. The probe process itself had
  accumulated a baseline of ~30 leaked connections across 8 prior gateway lifecycles in the
  same run (≈4 each), confirming the leak is cumulative.
- **Why it matters:** Every server restart/recreate, every test that builds a gateway, every
  multi-tenant teardown leaks 4 connections until Redis hits `maxclients`. Directly
  contradicts a clean plugin lifecycle.
- **Proposed direction:** Register `onClose` to `disconnect()` every channel (track them, or
  have the awaiter expose a real `dispose()` that disconnects both channels). Couples to
  GW9 (own the read-error path) and the core `streamAwaiter` disposer shape.

### GW6 — Per-route `timeout` silently ignored · Medium · [verified]

The awaiter's deferral timeout is taken from **plugin-level** `options.timeout`; the
per-route `timeout` field (present on `StreamersonRouteOptions`) is only spread into
`fastify.route(...)`, where Fastify core has no matching per-route response-timeout, so it
does nothing.

- **Evidence (scenario 3):** route `timeout: 300`, worker delays 800ms, no plugin timeout →
  request **succeeds at ~810ms** (default 3000 used; route 300 ignored). With plugin
  `timeout: 300` instead → `500` at ~311ms (mechanism works at plugin level only).
- **Why it matters:** The **shipped `app-hello-world` example** sets `timeout: 1000` on the
  route — a documented no-op. Users will set per-route timeouts that silently don't apply.
- **Proposed direction:** Honor `route.timeout` by giving each route's dispatch its own
  effective timeout (per-call timeout on `dispatch`, or a per-route awaiter), or drop the
  field and fix the example. Decide which; spec it.

### GW7 — Void/undefined handler return → dropped → timeout · Medium · [verified]

`getWriteStream` drops any chunk with `payload == null` (correct for the F4 fix), but a
worker handler that legitimately returns nothing (a side-effect-only `DELETE`) produces a
null payload → dropped → the gateway never sees a response → timeout.

- **Evidence (scenario 4):** `DELETE /thing` whose handler returns `undefined` → `500` at
  ~610ms (plugin timeout 600), not an empty `200`/`204`.
- **Why it matters:** No-content responses are normal REST; here they manifest as timeouts.
- **Proposed direction:** Tie to GW3's response-envelope spec — a worker should be able to
  signal "done, no body" as a real terminal response (empty payload sentinel) that the
  gateway maps to `204`/`200`. Distinguish "no body" from "no response."

### GW8 — `DeferralTracker` per-timeout leak · ✅ FIXED

Closed in **core**: both `dispatch` impls (the `StreamAwaiter` class + the `streamAwaiter` factory) wrap write+await in a `try { … } finally { stateTracker.delete(id) }`, and `DeferralTracker.delete` clears the armed timer — so the entry **and** its timer are released on every outcome (success, timeout, write failure). Guard: `packages/core/test/streams/deferred-stream-consumer/deferral-cleanup.test.ts` (green).

### GW9 — Response reader has no error path; a Redis hiccup can crash the process · Medium · [code]

```ts
stateTracker.readResponseStream().catch((err: unknown) => { throw err; });
```

`readResponseStream` only `await`s the *setup* (attach `.on('data')`), so this `.catch`
re-throwing produces an unhandled rejection at best and is otherwise decorative. The actual
read loop runs inside the `Readable` returned by `getReadStream`; **no `'error'` listener is
attached** to it. If `iterateStream`/`blockingStreamBatchMap` throws on a live read (Redis
drop mid-`XREAD`, not during intentional close), the Readable emits `'error'` with no
listener → an unhandled `'error'` event (process-fatal in Node/Bun semantics).

- **Why it matters:** The response channel is the gateway's lifeline; a transient Redis
  blip taking down the whole HTTP server is a poor failure mode. Not forcibly reproduced
  (would require killing the connection mid-read deterministically), but the missing
  listener is unambiguous in the code.
- **Proposed direction:** Attach an `'error'` handler on the response stream that logs and
  triggers a reconnect/re-arm; replace the `.catch(throw)` with real handling. Couples to
  GW5's lifecycle work.

### GW10 — `register({ prefix })` is ignored · Low-Med · [verified]

The plugin is wrapped in `fp(...)` (fastify-plugin), which intentionally breaks
encapsulation — including the registration `prefix`.

- **Evidence (scenario 6):** registered with `{ prefix: '/api' }`, `GET /api/ping` → `404`,
  `GET /ping` → `200`. The prefix is dropped.
- **Why it matters:** Surprising; the standard Fastify idiom for mounting a plugin under a
  path doesn't work. Either by design (routes must be app-root visible) or an oversight.
- **Proposed direction:** Document the constraint explicitly, or expose a `prefix` option on
  `CreateGatewayPlugin` that's applied to the routes. Decide intent first.

### GW11 — `.inject()` crashes under Bun → standard black-box testing is unavailable · Low-Med · [verified]

Fastify's `.inject()` (light-my-request) reads `response._header`, which Bun's
`node:http` response object does not populate, throwing
`TypeError: undefined is not an object (evaluating 'response._header.match')` deep in the
send pipeline (then cascading to `ERR_HTTP_HEADERS_SENT`).

- **Evidence:** the first probe harness (`.inject`-based) crashed on the *happy path*;
  switching to real `listen()`+`fetch` made the identical scenario pass `200`.
- **Why it matters:** Given the project's integration-test-first philosophy, the natural way
  to test this plugin (`server.inject`) is unusable under the Bun runtime. The package's own
  `load-plugin.test.ts` sidesteps this only because it never injects a request.
- **Proposed direction:** Standardize gateway integration tests on real `listen({port:0})`
  + `fetch` (a small shared harness). This is a Bun×light-my-request issue, not a gateway
  bug, but it dictates how the package must be tested — worth a note in TESTING.md.

### GW12 — Non-Fastify keys spread into the route; user `handler` silently overridden · Low · [verified]

```ts
const defaultedRoute = { ...(route?.topic ?? options.topic).meta(), ...route };
fastify.route({ ...defaultedRoute, handler: async (...) => {...} });
```

`meta()` injects `{ namespace, sharded, mode }`; `...route` adds `messageType`, `timeout`,
`topic`. Fastify tolerates the unknown keys (all scenarios registered fine), but it's noise,
and if a caller passes their own `handler` in the route options it is silently replaced by
the plugin's.

- **Proposed direction:** Destructure the streamerson-specific keys out before handing the
  rest to `fastify.route`; document that the handler is owned by the plugin.

### GW13 — `request.sourceId` is vestigial · Low · [verified]

`decorateRequest('sourceId', '')` is set but never populated; `dispatch` always receives
`''` (scenario 2 confirms `sourceId: ""`). REST correlation is by `messageId`, so it's
dead weight carried over from the WSS gateway (where source-token routing matters).

- **Proposed direction:** Remove it, or populate it with something meaningful (request id)
  if downstream provenance is desired.

### GW14 — No per-route `messageType` validation · Low · [code]

`route.messageType as MessageType` is cast without a check; a route missing `messageType`
dispatches `undefined`, which no worker handler matches → guaranteed silent timeout.

- **Proposed direction:** Validate at registration; throw a clear configuration error.

### GW15 — Startup `'$'` join race on the response stream · Low · [code]

`readResponseStream` opens the producer stream at the default cursor `'$'`, whose tip is
resolved at the **first** `XREAD` — armed asynchronously *after* plugin registration. A
response written into that arm-up window is skipped (the core F5 "no atomic subscribe"
semantics, documented on `getReadStream`). The probes mask this with a settle delay; in
production the request→worker→response round-trip is normally slower than the reader's first
read, so it's improbable but not impossible (notably for the very first request after boot).

- **Proposed direction:** Consider arming the reader (and awaiting its first read) before
  `listen()`/before serving, or reading from `'0'`/a captured id. Tie to the core F5
  discussion; low priority.

---

## What works (confirmed good)

- **Correlation core path** [verified]: body in → worker → response out, correlated by
  `messageId`, returned as JSON. `200 {"echoed":{"hello":"world"},"ok":true}` (scenario 1).
- **Concurrency model** [code]: one read channel per topic fans responses out via the
  `DeferralTracker` keyed by `messageId`, so many in-flight HTTP requests share a single
  response reader without head-of-line blocking; writes are non-blocking `XADD`s.
- **Connection reuse** [code]: `getStreamAwaiter` caches by `inStream:outStream`, so N routes
  on one topic share one read/write channel pair (the CRUD example's 4 routes → 1 pair).
- **Single-or-array routes** and **per-route `topic` override** are supported and coherent.
- **Plugin-level timeout** works and fails fast (scenario 3b: `500` at ~311ms).

## Suggested triage order (for discussion)

1. **GW5 + GW9** (lifecycle/robustness) — correctness/stability. (**GW8**, the core leak,
   is **done** — it also benefited the WIP `state-machine` (the other `streamAwaiter`
   consumer); the WSS gateway uses a separate correlation mechanism and is unaffected.)
2. **GW4** (auth/TLS) — deployment blocker, small change.
3. **GW3 + GW7** (error/no-content envelope) — one joint spec with the consumer package.
4. **GW1** (request fidelity) — the defining REST limitation; needs a request-envelope spec.
5. **GW2 / GW6** — close the doc↔code gaps (implement or retract; fix the example).
6. **GW10–GW15** — hygiene/DX; cheap once the above are settled.

> None of these should be actioned without agreeing the spec first (CLAUDE.md). Several
> (GW1, GW2, GW3, GW7) are interface-defining and deserve a short design note before code.
