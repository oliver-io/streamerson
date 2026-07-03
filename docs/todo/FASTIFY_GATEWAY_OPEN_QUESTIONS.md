# Fastify Gateway — Open Questions (decisions pending before code)

> Companion to [`FASTIFY_GATEWAY_REVIEW.md`](./FASTIFY_GATEWAY_REVIEW.md). That file is the
> findings record; **this file is the decision queue.** Everything here is something we
> *left hanging* — each item is written as a complete question, with the exact code in
> question quoted, and the concrete fork that needs your call. Nothing is actioned without a
> decision first (CLAUDE.md: spec-first, no unilateral behavior/abstractions).
>
> Status: **GW5, GW6, GW8, GW9 (fully self-healing), GW14, GW15 closed.** Remaining open:
> GW4 (Q2), GW3+GW7 (Q3, parked), GW1 (Q4, parked), GW2 (Q5), GW10+GW13 (Q7, parked), GW12
> (Q8), GW11 (Q10). Ordered by the triage in the review doc, not by finding number.

---

## Decisions (2026-05-24)

| Q | Finding | Decision |
|---|---|---|
| **Q1** | GW9 self-heal | **✅ DONE.** Self-heal + "freeze time": reconnect with capped backoff (default infinite); in-flight deferrals suspended (frozen), resumed on recovery, backlog flushed; client abort (`AbortSignal`) ends a wait; `maxAttempts` → 503. Spec `../specs/GATEWAY_READER_SELF_HEAL.md`; guards `self-heal.test.ts`. |
| **Q2** | GW4 | **`getConnection` escape hatch only.** Surface `getConnection: () => RedisClient` on the plugin (factory: a fresh client per channel). Defer `rediss://`+AUTH+db in core to later. |
| **Q3** | GW3+GW7 | **DISCUSS WITH OWNER FIRST — do not start.** The terminal-response envelope is to be designed together, in depth. |
| **Q4** | GW1 | **DISCUSS LATER (with Q3) — do not start.** |
| **Q5** | GW2 | **Implement as an opt-in route mode.** Per-route `awaitResponse:false`/`fireAndForget` → `XADD` + `202`, no deferral. Default stays request/response. |
| **Q6** | GW6 | **✅ DONE.** `route.timeout` honored as an optional per-call timeout (`dispatch(..., { timeout })` → `promise(id, timeoutMs)`); also re-armed on resume so an outage freeze (Q1) suspends it too. Guard: `self-heal.test.ts` "per-call timeout override (Q6)". |
| **Q7** | GW10+GW13 | **DISCUSS LATER — needs a walkthrough.** Owner wants the `fp`/encapsulation/`prefix`/`sourceId` coupling explained before deciding. |
| **Q8** | GW12 | **Approved.** Destructure streamerson keys out before `fastify.route`; decide handler-collision handling. Bundle with the next plugin edit. |
| **Q9** | GW15 | **✅ DONE.** Reader seeds from a captured tip (not `'$'`) and resumes a re-arm from the last *delivered* id — closes cold-boot and makes Q1's backlog flush correct (no dup, no loss). Built with Q1. |
| **Q10** | GW11 | **Approved, integration-first bar.** `listen()`+`fetch` harness + a `TESTING.md` note. Promote `tmp/` probes **only** where they cover an untested logical surface / contractual promise — audit, don't bulk-import. |

> **Build order implied by the above:** ~~Q1 + Q9 + Q6~~ **DONE** (self-heal unit — spec
> `../specs/GATEWAY_READER_SELF_HEAL.md`). Q2, Q5, Q8 are independently buildable once we pick
> them up. Q3, Q4, Q7 are parked pending a conversation with the owner.

---

## Q1 — GW9 follow-up: should the response reader *self-heal*, and what happens to in-flight requests when it dies?

**Context.** The no-crash floor is in: a non-intentional read error on the response stream
is now *consumed* (logged) instead of taking down the process. Here is the handler we added
(`packages/core/src/deferral/stream-awaiter.ts`):

```ts
const onData = (e: T) => { stateTracker.emit('response', e); };
// consume the stream's 'error' so a non-intentional read failure can't surface as an
// unhandled (fatal) event; the disposer removes it (GW9).
const onError = (err: unknown) => { (options.logger ?? console).error(err, 'streamAwaiter: response stream error'); };
stream.on('data', onData);
stream.on('error', onError);
return () => { stream.off('data', onData); stream.off('error', onError); void readChannel.abort(); };
```

That error originates here, when a live read fails for a reason *other* than an intentional
close (`packages/core/src/datasource/streamable.ts`, `blockingStreamBatchMap`):

```ts
} catch (err) {
  if (this.closing) {
    // Read interrupted by an intentional disconnect — not an error.
    return { cursor: options.last ?? '$', events: [] };
  }
  this.logger.error(err);
  throw new Error(`Failed XREAD [key=${options.stream}, shard=${options.shard}]`);
}
```

**The problem that remains.** After `onError` logs, the `Readable` is done. The reader does
**not** restart. So the binding goes *silent*: the gateway keeps accepting HTTP requests, but
no future response can ever correlate — every subsequent request to that topic now hits its
dispatch timeout and returns a 500. We traded a loud crash for a silent black hole on that
binding.

**The decision (two parts):**

1. **Re-arm?** Should the reader self-heal — on `onError`, tear down the dead stream,
   reconnect the channel (the underlying `RedisClient` is closed, so a bare re-`getReadStream`
   would just re-throw; recovery requires `readChannel.connect()` again), and re-attach
   `onData`/`onError` — behind a **bounded backoff** so a hard-down Redis can't spin a tight
   reconnect loop? Or is "log and stay down until the process is restarted by a supervisor"
   an acceptable floor (and we just make the silent-binding state observable, e.g. a metric /
   `'error'` event the host app can watch)?

2. **In-flight requests at the moment of failure.** The requests already waiting on a
   deferral when the reader dies will currently just hit their per-request timeout. The
   `DeferralTracker` already has a fail-fast primitive (`packages/core/src/deferral/deferred-promise-tracker.ts`):

   ```ts
   cancelAll(message?: string) {
     for (const id in this.promises) {
       this.cancel(id, message);   // rejects each pending promise with CANCELLED
     }
   }
   ```

   Should a reader death `cancelAll(...)` so those requests fail *immediately* with a clear
   error (e.g. 503), instead of every one of them paying the full timeout? Or leave them to
   time out (simpler, but slow and opaque)?

> **Where the fix lives:** core `readResponseStream` (+ possibly a small reconnect helper on
> the channel). This is the one piece of GW9 that touches core *behavior*, which is why I
> didn't slip it in with the floor.

### Resolved design (2026-05-24) — pending sign-off on the new surface

> Full concurrency model & race analysis: [`../specs/GATEWAY_READER_SELF_HEAL.md`](../specs/GATEWAY_READER_SELF_HEAL.md).

**Layering (keep the library↔caller line clean).** Self-heal *policy* lives in the
**awaiter** (the caller of the read primitive), not buried in the low-level read loop. Three
layers, each with one job:

- **`StreamingDataSource` — transport primitive.** Stays dumb about resilience. Gains one
  mechanic: `reconnect()` — close the dead client(s), stand up a fresh one, and clear the
  `closing` latch (today `disconnect()` sets `closing=true` and nothing resets it, so a naive
  disconnect→connect would wedge the read loop into the intentional-close branch forever). It
  also exposes the current stream tip for cursor seeding (reuse the existing private
  `lastGeneratedId`). It does **not** know about backoff/freeze.
- **`DeferralTracker` — correlation primitive.** Gains `suspendTimeouts()` / `resumeTimeouts()`.
  Suspend is a *state*: it clears every armed timer without rejecting, and while suspended a
  new `promise(id)` registers WITHOUT arming its timer. Resume re-arms every pending entry
  with a fresh full timeout (grace = full timeout measured from recovery — "freeze time").
- **awaiter `readResponseStream` — resilience policy (the orchestrator).** Owns the state
  machine and the cursor.

**Cursor model (this is the Q9 fix).** The reader seeds its FIRST read from a *captured
concrete tip* (`lastGeneratedId(producerStream)`), not `'$'` — closing the cold-boot gap. It
records `lastCursor = event.streamMessageId` on every `onData` (entries arrive in order, so
the last one is the cursor). On re-arm it resumes from `lastCursor` (or the captured tip if no
event has been seen yet) — **never `'$'`** — so every response written during the outage
(the backlog) is read on recovery instead of skipped.

**State machine.** HEALTHY → (non-intentional read `'error'`) → OUTAGE: `suspendTimeouts()`,
then reconnect with capped exponential backoff; on each attempt `readChannel.reconnect()` +
re-arm `getReadStream({ stream, last: lastCursor ?? capturedTip })` → on first successful
re-arm: `resumeTimeouts()`, back to HEALTHY (the backlog flows in and resolves the thawed
deferrals; any with no response ride a fresh full timeout). The disposer sets a `disposed`
flag that also aborts an in-progress reconnect loop.

**Configurable (your Q2-of-Q9 decision).** A `reconnect` option on the awaiter, surfaced on
the plugin:

```ts
reconnect?: {
  baseMs?: number;       // initial backoff (default ~100)
  maxMs?: number;        // backoff ceiling (default ~5000)
  factor?: number;       // default 2
  maxAttempts?: number;  // default UNDEFINED = reconnect forever, freeze pending forever
};
```

- **Default (no `maxAttempts`):** infinite reconnect; in-flight requests pend the whole time;
  only the **client's own** connection/abort ends a wait.
- **`maxAttempts` (or a total-time cap) set:** on exhaustion, `stateTracker.cancelAll('reader
  unavailable')` → every pending dispatch rejects → the gateway maps that to **503**.

**Scope.** This covers the **read / response** path (the GW9 finding). The write path is
separate: if `writeToStream` fails (e.g. Redis fully down), `dispatch` already rejects and the
request fails fast on the write side — a request that can't be enqueued is not "in flight" and
is out of scope here. Freeze applies to requests already written and awaiting a response.

**New surface to approve (per CLAUDE.md — propose abstractions before building):**
`StreamingDataSource.reconnect()` + a public tip read; `DeferralTracker.suspendTimeouts()` /
`resumeTimeouts()`; the `reconnect` options object. No new classes — the state machine is
logic inside `readResponseStream` (a private helper on the awaiter if it grows).

---

## Q2 — GW4: what is the connection-config escape hatch for a secured / managed Redis?

**Context.** The plugin builds its channels with **only host and port**
(`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
const [readChannel, writeChannel] = [
  new StreamingDataSource({
    logger: options.logger as any,
    controllable: true,
    host: options.streamOptions?.redisConfiguration?.host,
    port: options.streamOptions?.redisConfiguration?.port
  }),
  new StreamingDataSource({ /* identical: host, port only */ })
];
```

Core then turns that into a plain `redis://host:port` with no auth and no TLS
(`packages/core/src/datasource/base/remote.ts`):

```ts
private redisUrl() {
  const host = this.options.host ?? DEFAULT_HOST ?? 'localhost';
  const port = this.options.port ?? (Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 6379);
  return `redis://${host}:${port}`;
}

private make(): RedisClient {
  return this.options.getConnection
    ? this.options.getConnection()
    : new RedisClient(this.redisUrl(), { idleTimeout: 0 });
}
```

The core options type *does* already have an injection point, but the plugin never surfaces
it (`packages/core/src/types.ts`):

```ts
export type DataSourceOptions = Partial<{
  getConnection: () => RedisClient;   // <- exists, but the gateway plugin doesn't expose it
  port: number;
  host: string;
  logger: StreamersonLogger;
  controllable: boolean;
  maxLen: number;
}>;
```

There is **no** password / username / TLS / db field anywhere in the chain.

**Why it matters.** As-is, the gateway cannot connect to Upstash, ElastiCache-with-auth,
Redis Cloud, or anything requiring `rediss://` + AUTH — i.e. effectively any production Redis.
A deployment blocker.

**The decision — pick the depth:**

- **(a) Minimal escape hatch:** surface the existing `getConnection: () => RedisClient` (and
  the `controllable`/`maxLen` knobs) on `CreateGatewayPlugin`'s options, so a user supplies
  their own fully-configured `RedisClient`. Smallest change, no core edits; the plugin builds
  two channels per binding, so `getConnection` must mint a *fresh* client per call (factory,
  not singleton) — is that contract acceptable?
- **(b) First-class connection options:** extend core's `redisUrl()` (or `DataSourceOptions`)
  with `{ username?, password?, tls?, db? }` and emit `rediss://…@host:port/db`, then thread a
  `redisConfiguration`-shaped object through the plugin. More work in core, but ergonomic and
  the obviously-right long-term shape.
- **(c) Both:** ship (a) now as the unblocker, plan (b) as the real surface.

What should the *public option on the plugin* look like, and do we touch core (`redisUrl`)?

---

## Q3 — GW3 + GW7: how does a worker's non-success reach the HTTP client? (the terminal-response envelope)

This is the big interface decision, and GW3 and GW7 are the same question wearing two hats:
**"error" and "done, no body" are both terminal outcomes that aren't a normal JSON body.**

**Context — today every non-success is invisible and collapses to one opaque 500 at full
timeout cost.** Trace the four ways a worker can fail to produce a body:

1. **Handler throws** — the consumer swallows it and advances
   (`packages/consumer/src/base/stream-consumer.ts`):

   ```ts
   setState(object).then((message) => {
     this.push(message);
     callback();
   }).catch((err) => {
     // Never wedge the pipeline (CG-G2): log and advance.
     logger.error(err, 'Stream handler failed; skipping message');
     callback();   // <- nothing is written back to the producer stream
   });
   ```

2. **Unregistered messageType** — `process()` returns an `Error` *object*
   (`stream-consumer.ts`):

   ```ts
   async process(streamMessage: MappedStreamEvent) {
     if (!this.streamEvents[streamMessage.messageType]) {
       const error = new Error('No handler registered for message type: ' + ...);
       this.logger.error(error);
       // sus-- do we want to stream the error back?  probably need to TODO: wrap this
       return error;   // <- flows down the pipe as a chunk with no messageId
     }
     return await this._handle_message(streamMessage);
   }
   ```

3. **Handler returns void (this is GW7)** — `_handle_message` produces `payload: undefined`.

   For both (2) and (3), the write side then **drops the chunk**
   (`packages/core/src/datasource/streamable.ts`, `getWriteStream`):

   ```ts
   write: (chunk: MappedStreamEvent, _enc, callback) => {
     try {
       if (!chunk.messageId || chunk.payload == null) {
         this.logger.warn(`Dropping message with no messageId or payload: ...`);
         return callback();   // <- no response ever reaches the producer stream
       }
       ...
   ```

4. **No worker at all** — nothing consumes; nothing is written.

In all four cases the gateway's reader never hears a correlated response, so the dispatch
deferral simply times out and the handler returns a generic 500 — *after the full timeout*,
with the real cause (a known-instantly validation error, say) nowhere in the response.

**The missing half is already partly built.** `DeferralTracker` has an error path that would
*reject* the waiting dispatch (`packages/core/src/deferral/deferred-promise-tracker.ts`):

```ts
errorEvent(event: MappedStreamEvent) {
  const {messageId} = event;
  if (this.promises[messageId]) {
    this.promises[messageId].reject(event);   // <- would reject the dispatch promise
    if (this.promises[messageId].timeout) clearTimeout(this.promises[messageId].timeout);
  } else { /* ... */ }
}
```

…but the gateway's reader only ever emits `'response'`, never `'error'`
(`packages/core/src/deferral/stream-awaiter.ts`):

```ts
const onData = (e: T) => { stateTracker.emit('response', e); };   // 'response' only — never 'error'
```

…and the handler awaits a plain value with no error mapping
(`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
const response = await streamStateTracker.dispatch(
  JSON.stringify(request.body ?? {}),
  route.messageType as MessageType,
  request.sourceId
);
reply.send(response);
```

**The decision — design a terminal-response envelope.** The coherent end-to-end shape:

1. **Worker** writes a real response carrying the **same `messageId`** for *every* terminal
   outcome — success (body), error (status + message), and no-content (an explicit empty
   sentinel) — instead of dropping. (This couples to `@streamerson/consumer`; note it already
   has a richer terminal model for the *consumer-group* path — `respondAndAck` /
   `deadLetterAndAck` — but the plain `StreamConsumer` the gateway examples use does not.)
2. **Reader** inspects `messageType` and emits `'error'` (→ `errorEvent` rejects) vs
   `'response'` (resolves).
3. **Gateway handler** catches the rejection and maps it to a real HTTP status; maps the
   empty sentinel to `204`/`200`.

Questions to settle: the envelope's wire shape (a reserved `messageType` for error/empty? a
`status` field?); whether the **plain** `StreamConsumer` should reuse the consumer-group
dead-letter machinery or get its own response-error write; how a handler distinguishes
"return nothing → 204" from "throw → 5xx → mapped status"; and whether errors carry a
client-safe message vs. an opaque id (don't leak internals). **This deserves a short written
spec before any code**, jointly across consumer + core + gateway.

---

## Q4 — GW1: what part of the HTTP request reaches the worker, and in what shape?

**Context.** Only the body is marshaled (`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
const response = await streamStateTracker.dispatch(
  JSON.stringify(request.body ?? {}),   // <- body only
  route.messageType as MessageType,
  request.sourceId
);
```

…and the wire carries a fixed field set with no slot for query/params/headers
(`packages/core/src/datasource/streamable.ts`, `writeToStream`):

```ts
const fields = [
  'messageId', String(messageId),
  'messageType', String(messageType ?? this.responseType),
  'incomingStream', incomingStream ?? '',
  'messageHeaders', 'nil',
  'messageProtocol', 'json',
  'messageSourceId', sourceId ?? '',
  'payload', message,   // <- the stringified body, and nothing else
];
```

So `GET /item/:id?q=hello` with an `Authorization` header arrives at the worker as `{}`. For
a *REST* gateway this is the defining limitation: path params, query strings, auth headers,
idempotency keys, content negotiation — none are expressible. The shipped CRUD example has
`GET /data` / `DELETE /data` with no way to pass an id except an unconventional body.

**The decision — define a request-envelope contract.** Marshal a structured
`{ body, query, params, headers? }` into the payload (or let a route opt into which parts to
forward). This is **security-relevant** and needs a spec, not a reflex: headers must be
**allow-listed** (never blindly ship `Authorization`/`Cookie` onto a shared stream that may
be drained to SQL by reverse-streamers), and the envelope must be **size-bounded**. Open
questions: envelope shape and field names; per-route opt-in vs. a global default; the header
allow-list policy and size cap; and whether the worker-side handler signature changes (it
currently receives `payload` only) — which couples back to the consumer package and the wire
format in Q3.

---

## Q5 — GW2: implement fire-and-forget, or retract the claim?

**Context.** The README advertises a mode that does not exist
(`packages/gateway-fastify/README.md`):

> *"It can operate in a fire-and-forget mode (no 'call-and-response', just the 'call'), which
> allows this plugin to directly act as a RESTful producer-endpoint for an event stream."*

But the handler *always* registers a deferral and awaits a correlated response — there is no
`awaitResponse: false` path:

```ts
const response = await streamStateTracker.dispatch(/* ... */);
reply.send(response);
```

With no worker, such a route just blocks to the timeout and 500s.

**The decision:** either **implement** a per-route `awaitResponse: false` (or `fireAndForget`)
that `XADD`s the request and immediately returns `202 Accepted` *without* registering a
deferral — which matches the stated philosophy and is the smaller of the two gaps — **or
retract** the README claim. If we implement it: what's the option name, the success status
(`202`?), and the response body (echo the `messageId` so the producer can be traced)?

---

## Q6 — GW6: honor per-route `timeout`, or drop it and fix the example?

**Context.** The deferral timeout is taken from the **plugin level**
(`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
existingAwaiter = streamAwaiter({
  /* ... */
  timeout: options.timeout   // <- plugin-level only
});
```

The per-route `timeout` field exists on `StreamersonRouteOptions` and is spread into
`fastify.route(...)`, where Fastify core has no matching per-request response timeout — so it
is a **silent no-op**. Worse, the shipped `app-hello-world` example sets it:

```ts
routes: { method: 'GET', url: '/', messageType: Events.HELLO, timeout: 1000 }
```

To honor it, the timeout would have to become per-dispatch. Today it's baked into the tracker
at construction (`packages/core/src/deferral/deferred-promise-tracker.ts`):

```ts
this.promises[id] = {
  self: promise, resolve, reject,
  timeout: global.setTimeout(() => reject!(this.staticTimeoutError), this.timeout) as unknown as NodeJS.Timeout,
};
```

**The decision:** either **honor `route.timeout`** by threading a per-call timeout into
`dispatch` → `promise(id, timeoutOverride?)` (a small core change; *not* per-route awaiters,
which would break the connection-sharing the review credits under "What works"), **or drop**
the `route.timeout` field entirely and fix the example. Which?

---

## Q7 — GW10 + GW13: the `fastify-plugin` wrapper, `prefix`, and the vestigial `sourceId` (one coupled decision)

**Context.** The plugin is wrapped in `fp(...)`, which intentionally breaks Fastify
encapsulation — so `register(plugin, { prefix: '/api' })` is **ignored** (routes mount at the
app root, GW10). The wrapper exists (at minimum) to make this decoration + the routes visible
at the app root (`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
return fp(async (fastify) => {
  fastify.decorateRequest('sourceId', '');   // <- the decoration the fp wrapper is for
  /* ... routes registered here are NOT encapsulated, so `prefix` doesn't apply ... */
}, {});
```

But `sourceId` is **vestigial** (GW13): decorated to `''`, never populated, and passed as a
constant empty string into every dispatch:

```ts
const response = await streamStateTracker.dispatch(
  JSON.stringify(request.body ?? {}),
  route.messageType as MessageType,
  request.sourceId   // <- always '' for REST; correlation is by messageId
);
```

REST correlation is by `messageId`, so `sourceId` is dead weight carried over from the WSS
gateway (where source-token routing matters).

**The decision (coupled):** if we **remove `sourceId`**, the `fp` wrapper may no longer be
needed, and dropping it would make the plugin a normal *encapsulated* plugin → `prefix` works
(fixing GW10 for free). The trade-off: encapsulation means routes become **registration-scoped**
rather than app-root-visible — a behavior change for any existing user relying on root-level
mounting. So: (a) drop `sourceId` + drop `fp` → prefix works, routes encapsulated; or
(b) keep `fp`, remove `sourceId` anyway, and **document** that `prefix` is unsupported by
design; or (c) keep `sourceId` but **populate** it with something meaningful (a request id)
if downstream provenance is actually wanted. Which intent?

---

## Q8 — GW12: route-option hygiene (and a silently-overridden user `handler`)

**Context.** Streamerson-specific keys are spread straight into `fastify.route(...)`
(`packages/gateway-fastify/src/stream-plugin.ts`):

```ts
const defaultedRoute = { ...(route?.topic ?? options.topic).meta(), ...route };
// meta() => { namespace, sharded, mode };  ...route adds { messageType, timeout, topic }
fastify.route({
  ...defaultedRoute,
  handler: async (request, reply) => { /* ... */ }   // <- always the plugin's handler
});
```

Fastify tolerates the unknown keys (`namespace`, `sharded`, `mode`, `messageType`, `timeout`,
`topic`), so it's harmless noise — **except** that if a caller passes their own `handler` in
the route options, it is silently replaced by the plugin's (since `handler:` comes after the
spread).

**The decision:** destructure the streamerson keys out before handing the rest to
`fastify.route`, and **document** that the handler is owned by the plugin (or throw if a
caller supplies one). Cheap once we touch this file again — bundle with whichever pass edits
the plugin. Confirm the approach.

---

## Q9 — GW15: the `'$'` join race — and why it's actually the foundation for Q1

> **Reframed (2026-05-24): not low-priority.** The cold-boot race is minor on its own, but the
> *same* `'$'` cursor problem appears on Q1's reconnect — and there it is **fatal**: re-arming
> the reader at `'$'` after an outage silently drops every response written *during* the outage
> (`'$'` resolves to the live tip at the moment of the first read, so the whole backlog is
> "before now" and is skipped). That backlog is exactly what Q1 promised to *flush*. So a
> loss-free, **resumable** cursor is the precondition for Q1 being correct, not a nice-to-have.

**Context.** The response reader opens the producer stream at the default cursor `'$'`, whose
tip is resolved at the **first** `XREAD` — armed asynchronously *after* registration
(`packages/core/src/datasource/streamable.ts`, `iterateStream`):

```ts
const args = {
  ...options,
  last: options.last ?? (options.stream ? '$' : {}),   // <- '$' = "from the live tip at first read"
};
```

A response written into that arm-up window is skipped (the core F5 "no atomic subscribe"
semantics, documented on `getReadStream`). It's improbable in production (the
request→worker→response round-trip is normally slower than the reader's first read) but
possible — notably for the very first request after boot.

**Resolved (2026-05-24):** read from a **captured concrete tip** (not `'$'`) and **retain +
resume** the cursor across re-arms. Specified jointly with Q1 — see *Q1 → Resolved design →
Cursor model*. (Reading from `'0'` is rejected: it would replay the entire producer-stream
history on every boot/re-arm.)

---

## Q10 — GW11: standardize the integration-test harness (testing infra, not a code bug)

**Context.** Fastify's `.inject()` (light-my-request) crashes under Bun — it reads
`response._header`, which Bun's `node:http` response doesn't populate
(`TypeError: undefined is not an object (evaluating 'response._header.match')`). The only
committed gateway test sidesteps this by never injecting a request
(`packages/gateway-fastify/test/integration/load-plugin.test.ts`):

```ts
test('the gateway plugin loads and registers its routes', async () => {
  const server = Fastify();
  await server.register(CreateGatewayPlugin({ topic: new Topic('test'), routes: [...] }));
  assert.notEqual(server, undefined);
  await server.close();   // never .inject() — that would crash under Bun
});
```

The Tier-A tests I just added use the working pattern: real `server.listen({ port: 0 })` +
`fetch`.

**The decision:** standardize gateway integration tests on a small shared
`listen({port:0})`+`fetch` harness, and add a note to `docs/specs/TESTING.md` that `.inject()`
is unusable under Bun (so nobody re-discovers it). This is a Bun×light-my-request issue, not a
gateway bug — but it dictates *how* the package is tested. Confirm you want the shared harness
+ the TESTING.md note (and whether to promote the `tmp/gateway-probe/` scenarios into
committed tests as part of it).
