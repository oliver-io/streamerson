# MODERNIZE.md

A sequenced **pre-development checklist** — get the house in order before new feature work. The "why" behind many items lives in **[PROJECT.md](./PROJECT.md)** (the gap list); this file tracks the modernization to-do.

> **Status (2026-07-31, `main` @ `02038cc`):** **Step 1 (Bun port) is complete.** **Step 2 (docs/examples) is mostly complete** — the remaining items are one open decision (`docgen` TSDoc scope) and the explicitly-deferred fresh-consumer sandbox (2.5). Detail below; completed steps are collapsed to one-line notes per this doc's own guidance.

---

## Step 1 — Port to Bun · ✅ DONE

The three payoffs all landed:

- ✅ **Native WebSocket server.** `gateway-wss` rewritten on `Bun.serve({ fetch, websocket })` (uWebSockets compiled into Bun); the `uWebSockets.js` native addon and its build step are gone. Integration suite covers round-trip, routing edges, auth edges, shutdown, malformed frames.
- ✅ **Native TS + test runner + workspaces/PM.** Bun is the runtime, package manager (single `bun.lock`), and test runner; `tsx`/`ts-node` dropped. Resolves the Yarn↔npm limbo (PROJECT Gap M). Nx removed.
- ✅ **Redis client — spike passed, core rewritten.** Bun's `RedisClient` *does* honor blocking stream reads via `send()` on a `.duplicate()`'d connection (the spike's central question — see `tools/spikes/`). `core/src/datasource/{base/remote,streamable}.ts` now run on Bun's client, with `RedisDataSource` as the swap seam; the `controllable`/`abort` model was revisited in the same pass (PROJECT Gap G — now a real option). `node-redis` is retained **only** where a library feature is needed: `state-machine` (RESP client-tracking invalidation, which Bun's client doesn't surface) and `benchmarking`.
- ✅ **Native `MAXLEN ~` trim backstop.** `XADD` writes use `MAXLEN ~ <maxLen>` when `options.maxLen > 0` — opt-in, off by default (a backstop, *not* the retention strategy; see PROJECT Gap B).
- ✅ **`piscina` → Bun `Worker`.** `ConsumerGroupCluster` on native Bun `Worker` (block-for-life): fixed `count`, runtime `scale()`, restart-on-crash, graceful drain; `piscina` dropped (PROJECT Gap I).
- ✅ **Test targets wired + `bun test`.** Broad integration suites run under Bun against a live Redis (PROJECT Gap K).
- ✅ **Runtime deps sanity-checked + modernized.** `fastify`/`pino`/`lodash.get`/`eventemitter3` verified under Bun, then the whole tree was audit-modernized (fastify 5, pino 10, lru-cache 11, uuid 14, eslint 10 flat config, TypeScript 6.0.3), unused deps purged, and missing internal/runtime deps declared.

---

## Step 2 — Docs & examples current and verified · 🟡 MOSTLY DONE

### 2.1 Doc-embedding pipeline · ✅ (one open decision)
- ✅ **Marker-pairing bug fixed.** `embed.ts` now matches each `BEGIN…END` block as a whole and rewrites the `END` to the `BEGIN` path, so stale/mismatched pairs can't drift.
- ✅ **Degenerate pairs repaired.** `consumer/README.md`'s markers now pair correctly.
- ⚠️ **OPEN DECISION — TSDoc scope.** `docgen` still generates/embeds `_API.md` via the `tsdoc` CLI (`tsdoc-markdown`). Confirm this output is still wanted; if yes, regenerate (2.4); if not, drop the step from the pipeline. *(The `tsdoc-markdown` dep was briefly dropped in the dep sweep and restored — the docgen TSDoc step works today.)*

### 2.2 Stale API references · ✅ DONE
- ✅ The deleted `ConsumerGroupTopic` symbol no longer appears in examples/tests/`GROUP.md` (only historical mentions in these meta-docs).
- ✅ `packages/state-machine/README.md` is real content (no longer the wss copy-paste).
- ⚠️ **`docs/PROTOCOL.md`** still documents the old positional packing — the one remaining stale API doc (PROJECT Gap L residual). Rewrite against `core`'s named-field format.
- ◻️ `packages/emitter/README.md` — confirm the doubled `StateEmitter` header is gone after a clean `docgen` run (2.4).

### 2.3 Make every embedded example run · 🟡 PARTIAL
- ✅ `verify-examples` type-checks the embedded examples/apps clean.
- ◻️ **Runtime** smoke-run of each `*.example.ts`/app against a live Redis is not yet a CI gate. Add it once retention/trim behavior is settled (so examples don't grow streams unbounded in CI).
- ✅ Shipped `console.*` debug logging stripped from the published streaming packages (PROJECT Gap J); residual in `state-machine`.

### 2.4 Regenerate from verified sources · ◻️ BLOCKED on 2.1 decision
- ◻️ Run `docgen`, confirm idempotency (re-run = no diff), commit. **Gate this on the TSDoc-scope decision** — regenerating with `tsdoc-markdown` 1.5.0 (vs the old 0.1.0) will churn `_API.md` formatting, so decide keep-vs-drop first.

### 2.5 Fresh-consumer sandbox validation · ◻️ FUTURE (spec only)
Unchanged — explicitly future work. Install the published/linked packages outside the monorepo, follow each README quick-start verbatim against a live Redis, log every friction point. *(Several friction points it would have caught — undeclared `@streamerson/core` deps, dead `ioredis` dep — were fixed in the dep modernization.)*

---

## After modernization

With the toolchain on Bun and the docs nearly caught up, the real backlog is the PROJECT.md gap list — **reverse-streamer retention (B)**, **multi-instance response routing (E)**, and the **gateway-fastify interface items (GW1–GW4, GW2, GW3/GW7)**. Each needs a spec before code (CLAUDE.md). MODERNIZE was the prerequisite; those are the work.

## Updating this doc

Check items off as they land; when a step is fully done, collapse it to a one-line note. Keep references to files/symbols (not line numbers).
