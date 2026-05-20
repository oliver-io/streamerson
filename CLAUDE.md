# CLAUDE.md

Operating guide for working in the `@streamerson` monorepo. This file is **topological and operational** — what the project is, where things live, how to drive the toolchain. It avoids line references and implementation detail (those go stale). For current status, known issues, and priorities, see **[PROJECT.md](./PROJECT.md)**.

> Canonical branch is whatever is newest on the remote (currently `reintegration-release`). Treat the newest pushed code as current; `main` and the older `cluster-consumer*` branches lag behind. Much of the current code was shaped by dogfooding the framework against a real game, so expect WIP debug logging and in-flight refactors — see PROJECT.md.

## What this is

Streamerson is an API framework built on the premise: **terminate HTTP/WebSocket traffic at the edge, and carry all interior service-to-service communication over a stream broker (Redis Streams) instead of more HTTP.** A gateway writes a request onto a stream; a worker consumes it, runs a handler, and writes a response onto a paired stream; the gateway correlates the response back to the waiting request by message id. Interior services never call each other directly.

The repo is a set of layered libraries that make this pattern ergonomic in TypeScript, plus gateways, examples, and benchmarking — and one standalone state library (`emitter`) that fell out of the dogfooding.

## How we work — development principles

This is a high-craft, bespoke repository: distributed-systems code where every line is deliberate and load-bearing. It is **not** a "ship fast, clean up later" project. These norms are non-negotiable; hold to them even when they override the default reflex to be fast or agreeable.

1. **Spec-first; never code into ambiguity.** Every change starts from a spec — written or talked through. If a request is ambiguous in any way, **stop and resolve the spec before writing code**: ask, propose, interrogate. A wrong line costs more than the conversation that would have prevented it. (This is why `PROJECT.md` and `MODERNIZE.md` exist — we plan, then build.) No shortcuts, no guessing at intent.

2. **Integration tests over unit tests.** Stability here comes from tests that exercise the real code path end-to-end (real Redis, real streams), not from mocked units. When a bug surfaces, the **first deliverable is an integration test that reproduces it**; the fix follows, and the test stays as a regression guard. Unit tests are welcome but secondary — a green unit suite over a broken code path is worthless. (Test wiring is currently a gap — see PROJECT.md Gap K — so this is the bar we restore toward.)

3. **Terse, self-documenting, low-level-minded code.** Write TypeScript with a systems programmer's attention: the shape and ownership of data, allocations on hot paths, serialization cost, what crosses the wire and the thread/process boundary. Think like a C programmer about **data structures and lifetimes** — but write idiomatic TypeScript, not transliterated C. Prefer precise names and exact types over comments; prefer the small, correct construct over the clever or sprawling one. No JS slop: no abstraction for its own sake, no helper soup, no leftover `console.log` debugging (that cruft is a known defect, not a pattern to copy).

4. **Verify, don't assert — back-correlate every hypothesis.** Be the ultra-careful developer. Never state behavior, root cause, or capability from intuition: form a hypothesis, then confirm it against the code path, a reproduction, or authoritative docs — and say which. Cite the evidence (file/symbol). Distinguish what you've verified from what you infer, and flag confidence honestly. Fast-but-wrong is failure; slow-and-correct is the job.

### Guardrails (hard rules)

- **No time estimates.** Do not estimate how long a task, feature, or project will take — no hours/days/sprints, no "quick" or "should be fast." Discuss scope, sequencing, risk, and dependencies instead; wall-clock is off-limits.
- **No unilateral shortcuts or abridgement.** Do not stub, simplify, truncate, hand-wave, defer-with-TODO, or otherwise leave anything partial unless that shortcut was explicitly discussed and agreed. If a shortcut looks warranted, surface it and get agreement first — never quietly abridge.
- **No undiscussed abstractions.** Do not introduce new abstraction layers — wrappers, base classes, indirection, generic helpers, config layers — that weren't discussed. Default to the **minimum** number of layers, and every layer must be justified and fully understood. When an abstraction seems necessary, propose it (spec-first) before building it.

## Mental model (request lifecycle)

```
client ──HTTP/WS──▶ gateway ──XADD──▶ [CONSUMER stream] ──▶ worker (consumer)
                       ▲                                         │ handler
                       └──── correlate by message id ◀──XADD──── ▼
                              [PRODUCER stream] ◀── response
```

Every `Topic` maps to **two stream keys**, named from the *worker's* perspective: a CONSUMER (incoming/request) stream and a PRODUCER (outgoing/response) stream. Gateways mirror this — they write to the consumer key and read from the producer key. `Topic.loopback()` returns a topic with the two keys swapped, which is how a gateway reads the response end.

## Topology

Layered; **dependencies point downward** — `core` is the base and the streaming packages sit on it. `emitter` is standalone. Don't introduce upward dependencies.

```
core  ◀── consumer  (StreamConsumer + consumer groups + cluster)
  ▲          ▲
  └── gateway-fastify, gateway-wss
  └── state-machine (WIP)
emitter   ── standalone state library (no streaming deps)
examples  ── depends on consumer + gateways
benchmarking, test-utils ── tooling/support
```

| Package | Role |
|---|---|
| `packages/core` | Base SDK. Wraps **node-redis** behind a datasource; `Topic`/key generation; streams exposed as `Readable`/`Writable`/`AsyncIterable`/`EventEmitter`; the request/response correlation utilities (`streamAwaiter`, `DeferralTracker`). Start here. |
| `packages/consumer` | The consumer/producer layer: `StreamConsumer` (bind a handler to a message type), plus consumer-**group** support (`ConsumerGroupMember`, `Configurator`) and a Piscina worker-thread **cluster**. (This package absorbed the former `consumer-group` package.) |
| `packages/emitter` | `@streamerson/emitter` — `StateEmitter`, a standalone observable-state library: subscribe to changes at any deep (lodash) path of a state object. Independent of the streaming layers; extracted from the game dogfooding. |
| `packages/gateway-fastify` | Fastify plugin: REST request ⇄ stream correlation. |
| `packages/gateway-wss` | uWebSockets server: WebSocket ⇄ stream adapter (routes responses to the right socket by source token). |
| `packages/state-machine` | WIP — distributed in-memory state machine over a stream. |
| `packages/examples` | Runnable apps (`app-basic-crud`, `app-hello-world`, `app-websockets`) and smaller snippets. README code blocks are embedded from here (see Docs). |
| `packages/benchmarking` | Artillery load tests + Terraform deploy (GCP/AWS) to measure overhead. |
| `packages/test-utils` | Shared test helpers. |

## Where to read

- `README.md` — architecture overview and the high-level pitch.
- `docs/WHY_STREAMS.md` — rationale for streams over HTTP internally.
- `docs/PROTOCOL.md` — wire format. **Note:** describes the older positional packing; the live code now writes named stream fields. Verify against `core` before relying on it.
- `docs/PARABLE.md` — motivating narrative.
- Each `packages/*/README.md` — per-package detail (some are stale/copy-pasted).
- `PROJECT.md` — current implementation status, known gaps, and roadmap.

## Toolchain

- **Yarn workspaces** (`packages/*`) + **Nx** as task runner (Nx Cloud caching). Lerna present for releases. **Note:** mid-migration from Yarn to npm — a `package-lock.json` is committed while scripts still invoke `yarn`. Prefer matching whatever the lockfile in the tree implies.
- **Node v20+**, **TypeScript ~5.1**, **CommonJS** modules. TS runs directly via **`tsx`** for tools/examples/load tests.
- **Redis** runs locally via Docker Compose (`redis:alpine` on `6379`). The code targets Redis-compatible servers (DragonflyDB has been a consideration — see PROJECT.md).

## Commands

```bash
yarn                 # install (workspaces)
yarn start:redis     # bring up local Redis (docker compose); stop:redis / restart:redis
yarn build           # build all packages (nx run-many -t build --all)
yarn test            # nx run-many -t test (see caveat below)
yarn docgen          # regenerate README embedded code blocks
yarn benchmark       # dockerized benchmarks
yarn loadtest        # dockerized artillery load tests
yarn clean           # clean, then reinstall + rebuild

# Per project (use the unscoped name: core, consumer, emitter, gateway-fastify, ...)
nx build <project>
nx test <project>
nx lint <project>
```

## Conventions & gotchas

- **`yarn test` currently exercises little.** Test *files* exist (core, consumer, gateways, emitter), but `project.json` files don't define `test` targets, so the Nx run finds almost nothing. Run a package's tests directly if you need them, and see PROJECT.md.
- **Integration tests need Redis up** (`yarn start:redis`).
- **Expect WIP debug output** in current code (`console.*` logging, including profanity, lives in shipped `core`/`consumer`). Don't mistake it for intentional behavior; see PROJECT.md.
- **READMEs are partly generated.** Code fenced between `<!-- BEGIN-CODE: path -->` / `<!-- END-CODE -->` is injected by `yarn docgen`. Edit the **source file**, then regenerate.
- **Shell scripts in `tools/` (`*.sh`) assume a POSIX shell.** On Windows use Git Bash/WSL; the `tsx`-based tools are cross-platform.
- Respect the layering: new cross-package code depends downward toward `core`, never upward. `emitter` stays standalone.
