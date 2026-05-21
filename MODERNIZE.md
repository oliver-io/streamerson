# MODERNIZE.md

A sequenced **pre-development checklist**. This is the work to do *before* any new feature development — get the house in order so we start from a trustworthy, modern baseline. The "why" behind many items lives in **[PROJECT.md](./PROJECT.md)** (the gap list); this file is the actionable to-do.

> **Baseline:** branch `reintegration-release` @ `8df9e61` (newest pushed). Treat this as current.
>
> **Sequencing rationale:** Bun port first (Step 1) because it changes commands, dependencies, native APIs, and the doc tooling itself (`tsx`/`docgen`) — rectifying docs before it would mean doing them twice. The port is largely a mechanical drop-in (native WS, runtime, PM); the one genuinely risky piece (Bun's Redis client lacks Streams) is isolated and gated. Docs/examples rectification follows (Step 2), once against the final post-Bun state. Only after both do the PROJECT.md gaps become the actual development work.

---

## Step 1 — Port to Bun

Adopt **Bun** to slim the stack — but the three payoffs land on different timelines (verified against Bun docs, May 2026 — see Research notes below):

- ✅ **Native WebSocket server** — Bun's `Bun.serve` WS *is* uWebSockets compiled into Bun, so we can drop the `uWebSockets.js` native addon in `gateway-wss` with near-1:1 API parity. Available now, lowest risk.
- ✅ **Native TS + bundler + test runner + workspaces/PM** — drop `tsx`/`ts-node`, resolve the Yarn↔npm limbo, simplify the build. Available now.
- ⚠️ **Built-in Redis client — gated, prototype-first.** Bun's client has **no typed Streams API** (Streams, Cluster, Sentinel, and transactions are unsupported or planned), and our `core` is entirely stream-based. It *does* expose `send(cmd, args)` (raw commands) and `.duplicate()` (dedicated connections), so a streams datasource is *possible* but unproven — especially blocking `XREADGROUP … BLOCK`. Do not block the rest of the port on this.

### 1.1 Adopt Bun as runtime + package manager
- [ ] `bun install`; adopt Bun workspaces; add `bunfig.toml` and pin a Bun version.
- [ ] Decide Nx's fate: keep it (for caching / `affected`) running under Node, or replace with `bun run` scripts + `bun build`. Pick one package manager and delete the other's lockfile (resolves PROJECT.md Gap M).

### 1.2 Redis client — prototype-first, decoupled from the rest of the port
Bun's built-in client cannot drop in for our stream-heavy `core` today (no typed Streams API). So **spike before committing:**
- [ ] **Validate the hot path** on Bun's client via raw commands: blocking `XREADGROUP`/`XREAD` with a `BLOCK` timeout through `client.send('XREADGROUP', [...])` on a dedicated `.duplicate()`'d connection, plus `XADD` (with `MAXLEN`), `XGROUP CREATE … MKSTREAM`, and `XACK`. The open question is whether `send()` actually honors blocking semantics (holds the connection and returns the late reply) — confirm this first.
- [ ] **If the spike passes:** rewrite `core/src/datasource/{base/remote,streamable}.ts` against Bun's client, keeping `RedisDataSource` as the swap seam, and revisit the `controllable`/abort model (PROJECT.md Gap G) while in this code.
- [ ] **If it doesn't (or until Bun ships typed Streams):** keep `node-redis` (or `ioredis`) for the streaming datasource — both run fine under Bun — and optionally use Bun's client only for plain KV ops. The port proceeds regardless.
- [ ] Add native `MAXLEN ~` trim in this code as an **opt-in, off-by-default, length-configurable** option (a backstop, *not* the retention strategy — that's reverse-streamers draining to SQL; see PROJECT.md Gap B + retention decision).

### 1.3 Replace uWebSockets.js in `gateway-wss` with `Bun.serve` (lowest-risk win)
Because Bun's WS server is uWebSockets compiled in, the current `wssapi.ts` model maps almost 1:1.
- [ ] Rewrite `wssapi.ts` on `Bun.serve({ fetch, websocket })`: auth/upgrade → `server.upgrade(req, { data })` inside `fetch`; the `server.ws(path, …)` handlers → the `websocket` handler object; `ws.subscribe(token)` / `server.publish(token, …)` / `ws.isSubscribed(token)` carry over directly; `server.numSubscribers(token)` → `server.subscriberCount(token)`.
- [ ] Pin a Bun version where WS pub/sub is stable (it was introduced experimental in Bun 1.2.23 and is GA in the 3.x line).
- [ ] Remove the `uNetworking/uWebSockets.js` git dependency → no native build step.

### 1.4 Slim the toolchain
- [ ] Drop `tsx` and `ts-node` (Bun runs TS directly); update `tools/*.ts` entry points and the `emitter` test script.
- [ ] Wire real test targets and migrate to `bun test` (or confirm `node:test` runs under Bun). Closes PROJECT.md Gap K.
- [ ] **RISK — `piscina` on Bun.** Confirm the consumer cluster's worker pool works under Bun; if not, move to Bun `Worker`. (Folds into the cluster-lifecycle decision, PROJECT.md Gap I.)
- [ ] Sanity-check the remaining runtime deps under Bun: `fastify`, `pino`, `lodash.get`, `eventemitter3` (expected fine).

**Step 1 done when:** `bun install` + build + `bun test` are green; `gateway-wss` has no native addon; the runtime/PM is Bun with exactly one package manager; examples run under Bun. (The core Redis-client swap is *not* a gate — it ships only if the 1.2 spike passes; otherwise the streaming datasource stays on node-redis under Bun.)

---

## Step 2 — Make the docs & examples current and verified

With the toolchain, dependencies, and native APIs now final (post-Bun), rectify the docs **once** against that final state. Goal: **every README and quick-start runs verbatim in a fresh sandbox, and the doc generator is idempotent.**

### 2.1 Understand & harden the doc-embedding pipeline
`docgen` (post-Bun: `bun ./tools/embed.ts -w --summary`) runs three enrichments over every `**/*.md`:
- **Code embedding** — content between `<!-- BEGIN-CODE: <relpath> -->
<!-- END-CODE: <relpath> -->` is replaced with the referenced source file, fenced and linked.
- **TOC** — `doctoc --github` injects/updates the table of contents.
- **API docs** — `tsdoc` generates `_API.md` next to any `.ts` containing `@param`, which is then embedded.

- [ ] **Fix the marker-pairing bug.** `embed.ts` pairs `BEGIN`/`END` markers **by index only** — it never checks that the two markers reference the same path. Make it assert `begin.path === end.path` (or drive purely off the `BEGIN` path and rewrite the matching `END`), and fail loudly on mismatch instead of silently embedding the wrong content.
- [ ] **Handle degenerate pairs.** `consumer/README.md` has an empty `BEGIN`/`END` pair on adjacent lines, and a `single-bidi` BEGIN paired with a `consumer-group-readable` END. Repair the markers once the tool validates them.
- [ ] **Decide TOC/TSDoc scope.** Confirm `doctoc` and `tsdoc` `_API.md` output is still wanted; if so, regenerate it; if not, drop it from the pipeline.

### 2.2 Fix stale API references (the half-finished `consumer-group` → `consumer` move)
The package merged into `@streamerson/consumer`, and import *paths* were updated — but the deleted symbol **`ConsumerGroupTopic`** (now `ConsumerGroupConfigurator` + a new `ConsumerGroupMember(options, memberSettings)` shape) was not. These still reference it and are broken:
- [ ] `packages/examples/consumers/groups/consumer-group-readable.ts` — imports a nonexistent export; rewrite to the current API.
- [ ] `packages/consumer/GROUP.md` — same stale snippet.
- [ ] `packages/consumer/test/{consumer-single,consumer-many,consumer-new-messages,consumer-existing-messages}.ts` and `bootstrap.test.ts` — update to the current API (ties to the test wiring done in Step 1 / PROJECT.md Gap K).
- [ ] `docs/PROTOCOL.md` — documents the old positional packing; the live wire format is now **named stream fields**. Rewrite to match `core` (PROJECT.md Gap L).
- [ ] `packages/state-machine/README.md` — currently a copy-paste of the wss-gateway README. Replace with real content.
- [ ] `packages/emitter/README.md` — de-duplicate the doubled `StateEmitter` header (embed/doctoc artifact).

### 2.3 Make every embedded example actually run
- [ ] Type-check and **run** each `*.example.ts` and each app (`app-hello-world`, `app-basic-crud`, `app-websockets`, `producers/example.ts`) against a local Redis (start Redis first).
- [ ] Add a `verify-examples` script: bring up Redis, run each example with a timeout, assert it doesn't throw and produces the documented output. This becomes a CI gate so docs can't silently rot again.
- [ ] Strip or gate the shipped `console.*` debug logging (PROJECT.md Gap J) — it currently drowns the example/consumer experience.

### 2.4 Regenerate from verified sources
- [ ] Run `docgen` and confirm it is **idempotent** (re-running produces no diff). Commit the regenerated docs.

### 2.5 Fresh-consumer sandbox validation — *(later; spec only)*
A dedicated pass to experience the framework as an outside user. **This is future work; specified here, not done now.**
- [ ] In a clean directory *outside* the monorepo, install the packages as a real consumer would (published versions, or `yalc` / `bun link`).
- [ ] Follow each README quick-start **verbatim** and confirm it works at face value against a local Redis.
- [ ] Log every friction point as an issue — e.g. undeclared dependencies (`@streamerson/consumer` imports `@streamerson/core` without declaring it; `consumer` still lists a dead `ioredis` dep), missing peer deps, debug-log spam, unclear setup steps.

**Step 2 done when:** every quick-start runs verbatim in a fresh sandbox against a local Redis; `docgen` is idempotent; no references to deleted symbols remain; examples are covered by a CI smoke test.

---

## After modernization (out of scope here)

With docs/examples trustworthy and the toolchain on Bun, the real development backlog is the PROJECT.md gap list — stream trimming (B), delivery semantics (C), multi-instance response routing (E), the correlation timeout leak (D), and the cluster lifecycle (I). MODERNIZE is the prerequisite; those are the work.

## Research notes (Bun, verified May 2026)

Facts behind Step 1 (Bun); re-verify before acting, since Bun moves fast.

- **Redis client:** Bun's built-in client (`Bun.redis` / `RedisClient`) targets Redis 7.2+. **Streams, Cluster, Sentinel, and transactions (MULTI/EXEC) are not in the typed API** — Streams are listed as planned. There is a raw `send(command, args)` escape hatch ("run any Redis command") and `.duplicate()` for separate/dedicated connections (the documented pattern for pub/sub). Whether `send()` correctly handles *blocking* stream reads is unverified and is the spike's central question.
- **WebSockets:** `Bun.serve` exposes a native pub/sub WS API built on the uWebSockets C++ library — `ws.subscribe`, `server.publish`, `ws.isSubscribed`, `server.subscriberCount`, with `server.upgrade(req, { data })` called inside the `fetch` handler. Pub/sub arrived experimental in Bun 1.2.23 and is stable in the 3.x line.

Sources:
- [Redis — Bun docs](https://bun.com/docs/runtime/redis)
- [Build a publish-subscribe WebSocket server — Bun docs](https://bun.com/docs/guides/websocket/pubsub)
- [Bun Introduces Built-in Database Clients (InfoQ, Jan 2026)](https://www.infoq.com/news/2026/01/bun-v3-1-release/)

## Updating this doc

Check items off as they land; when a step is fully done, collapse it to a one-line note and link the PR. Keep references to files/symbols (not line numbers).
