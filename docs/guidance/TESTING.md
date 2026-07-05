# Testing Guidance — actualizing the philosophy

This document is the **operational companion** to the philosophy in
[`docs/specs/TESTING.md`](../specs/TESTING.md). That file says *what we believe*
(integration-first, behavior over implementation, spec-as-contract); this file says
*how we actually do it* in this repository — with Bun, a live Redis, real worker
processes, and the shared harness. When the two disagree, the philosophy wins and this
file gets fixed.

The one-sentence version: **every test is an executable clause of a living spec — it
stimulates a real system through its public surface and asserts an externally
observable behavior or a ground-truth side-effect, never an implementation detail.**

---

## 1. The stance: behavior, contracts, ground truth

A test in this repo answers exactly one question: *"does the system honor this clause
of its contract?"* Not "does this function call that function," not "does this field
get set." Consequences:

- **The subject is real.** Real `StreamingDataSource` against a live Redis
  (`bun run start:redis`), real `ConsumerGroupMember`s, real Bun `Worker`s for cluster
  tests, real subprocesses for crash tests. We never mock Redis, never stub a
  streamerson class to test another streamerson class. We trust third parties (Redis,
  Bun) to work as documented and test **our** behavior on top of them.
- **The stimulus is the public surface.** Write a request onto the topic's consumer
  stream; call `scale()`; kill a worker process; break out of an iterator. If a test
  needs a private method to set up its scenario, the scenario is wrong (or the public
  surface is missing something — surface that as a spec question, don't reach inside).
- **The oracle is external.** Two legitimate places to assert:
  1. **Observable output** — the correlated response on the producer stream, the
     iterator yielding, the promise resolving/rejecting, the HTTP/WS reply.
  2. **Ground truth in Redis** — `XPENDING`, `XRANGE`, `XINFO GROUPS/CONSUMERS`,
     `XLEN`, the dead-letter stream. Redis is the shared source of truth for the whole
     framework, so asserting against it is asserting *behavior*, not implementation.
     The harness wraps these (`pendingCount`, `xlen`, `readDlq`, `readEntries`).

  What is **not** an oracle: framework-internal bookkeeping (a member's private map,
  a tracker's internal count). If internal state matters, it must matter *because* it
  produces an external effect — assert the effect.
- **Spies are for the unobservable only.** A spy is legitimate when a contract clause
  is invisible in the final output: "the handler was invoked exactly once per
  message," "the crash callback fired before respawn," "no write happened after
  dispose." A spy is a *sanity check on a guaranteed side-effect*, never a substitute
  for the behavioral assertion, and never a lever to steer control flow (that's a
  mock, and we don't).

## 2. Hypothesize the coverage surface before writing a test

Tests are designed top-down from the spec, not bottom-up from the code. For each
module/feature, enumerate the logical surface first — as a list of contract clauses —
then write one test per clause. The recurring axes in this codebase:

| Axis | Question | Example clauses |
|---|---|---|
| **Happy path** | Does the nominal flow fulfill the contract? | request → handler → correlated response by `messageId`; N messages → N responses. |
| **Sad path** | Are failures loud, typed, and intelligible? | handler throws → error response / DLQ entry with the original `messageId`; bad payload → rejection that names the cause. Assert on the *error content*, not just "it threw." |
| **Crash / partition** | What happens when a participant dies mid-flight? | member SIGKILLed after claiming → message reclaimable by a peer; poison message → bounded retries then DLQ, not a crash loop. Use **real subprocess fixtures** (`test/fixtures/*-member.ts`), not simulated throws — a simulated crash tests your simulation. |
| **Concurrency / distribution** | Do multiple real participants interleave correctly? | two members in one group → each message delivered to exactly one; reaper steals only from genuinely idle consumers, never from a slow-but-alive one. |
| **Conservation invariants** | Under load, is anything lost, duplicated, or leaked? | volume conservation: `sent = acked + dead-lettered + pending`, every response `messageId` distinct. These are the highest-value tests in a delivery system — they catch whole classes of bugs no example-based test finds. |
| **Lifecycle / resources** | Do setup and teardown leave nothing behind? | `dispose()` interrupts a blocking read promptly; `break` out of an iterator ends the underlying read loop (no orphaned XREAD); scale-down under load drains without dropping claimed messages. |
| **Negative / stability** | Does a forbidden thing *not* happen? | no duplicate delivery after ack; no respawn after graceful stop; no writes after teardown. See §4 for how to wait on these. |

A feature is covered when every clause on this grid that applies to it has a test —
not when a coverage percentage is hit. Coverage tooling (e.g. the
`test:coverage:reader` gate) is a *detector of untested surface*, useful on genuinely
critical single files; it is never the goal.

## 3. The harness: one rig, real dependencies, absorbed setup

Complicated setup lives in shared harness code, not re-declared per file
(philosophy §5). The consumer suite's `packages/consumer/test/harness.ts` is the
reference implementation of the pattern; new suites should follow its shape:

- **`testRig()`** — a per-file rig owning one admin datasource and LIFO teardown:
  `rig.topic(tag)` mints tracked topics whose keys are deleted at teardown;
  `rig.track(member)` registers anything with `disconnect()`; `rig.onTeardown(fn)`
  for the rest. `beforeAll(() => rig.connect())`, `afterAll(() => rig.teardown())`,
  nothing else.
- **Unique keys per run** — `makeTopic()` salts the topic name with time + randomness
  so parallel and repeated runs never collide. No test may depend on a fixed key name
  or on state another test left behind; every file must pass alone and under
  `bun test` in parallel.
- **Ground-truth helpers** — `pendingCount`, `xlen`, `readDlq`, `readEntries`,
  `consumerNames`: thin wrappers over raw Redis commands, robust across RESP2/RESP3.
  Keep them assertion-free; the test states the expectation.
- **Scenario constructors** — helpers that build a *precondition* through real
  operations, e.g. `abandonToPhantom()` delivers an entry to a throwaway group
  consumer that never acks, producing a genuinely abandoned PEL entry (the real
  precondition for reaper tests) rather than a faked one.
- **Process fixtures** — `test/fixtures/*.ts` are real entrypoints spawned as
  subprocesses/workers for crash, hang, wedge, and poison scenarios. The test kills or
  starves a *real* process and asserts what the survivors do. This is the repo's
  answer to "how do you test crash recovery without mocks."

Harness code is production-grade code: typed, terse, documented with *why* (which
philosophy clause it serves), and itself reviewed. A bug in the harness is a bug in
every test.

## 4. Time and asynchrony: converge, don't sleep

We run against real Redis, so there is no fake clock; the discipline is in how we
wait (philosophy §6):

- **Positive assertions: poll to convergence.** `await until(predicate, timeoutMs)`
  — returns as soon as the condition holds, so the suite runs at the speed of the
  system, and the timeout only spends its budget on genuine failure. Never
  `await sleep(2000)` before asserting something *happened*: it's slow when the
  system is fast and flaky when the system is slow.
- **Negative assertions: bounded window, then assert absence.** A fixed `sleep` is
  correct *only* here — give the forbidden event a realistic window to occur, then
  assert it did not (`pendingCount === 0` still, spy call-count unchanged). State the
  window's rationale in the test (e.g. "> 2× the reap interval").
- **Timeout budgets are failure detectors, not pacing.** Size them generously
  relative to the mechanism under test (block timeouts, reclaim `min-idle`, respawn
  backoff) so they never fire on a healthy system; a test that passes only with a
  tight race is a flaky test reporting itself.
- **Every await converges or fails — nothing dangles.** Readers opened by a test are
  raced against a deadline and then aborted/disconnected (`collectResponses`,
  `awaitResponse` show the shape). A test that leaks a blocking read poisons the rest
  of the file.

## 5. Sad paths and fail-fast are first-class

Half the contract is what the system does when things go wrong (philosophy §§8–9):

- Every feature test set includes the failure clauses from the §2 grid — a happy-path
  suite is half a suite.
- Assert that errors are **intelligible**: the right type, carrying the identifying
  context (`messageId`, stream key, cause). "It rejected" is not an assertion.
- Never make a test pass by making the implementation quieter. If a test exposes a
  silent failure, the fix is to make the implementation fail eagerly and then assert
  the loud failure. Swallowed errors introduced to green a test are defects.

## 6. Bug → RED test → fix, in that order

When a real bug surfaces (philosophy §10):

1. Write the integration test that reproduces it through the public surface.
2. **Run it and watch it fail** — the failure message should implicate the bug
   (this validates the hypothesis; a repro you never saw red proves nothing).
3. Fix the implementation until the test passes.
4. The test stays forever as the regression guard.

When a bug is confirmed but its fix is deferred (spec-first: the fix needs design),
the RED test is still written and checked in as the **pinned specification of the
defect** — intentionally failing, marked as such — so the suite is an honest map of
what works and what is known-broken.

## 7. What we don't test, and the narrow unit-test exception

- We don't test Redis, Bun, or Fastify themselves — only our behavior on them.
- We don't write tests that restate the implementation (tautological units,
  "constructor sets field" tests, snapshot-the-internals tests).
- We don't chase coverage numbers with meaningless tests (philosophy §7).
- **Exception:** a pure function with genuinely variadic, complicated logic (key
  generation, serialization edge cases, reply-shape parsing) may earn a focused unit
  test — still black-box over its inputs/outputs, still spec-clause-shaped. This is
  rare and secondary; a green unit suite over a broken code path is worthless.

## 8. Mechanics and conventions

- **Runner:** `bun:test` only (`describe`/`it`/`expect`, `beforeAll`/`afterAll`).
  Legacy `node:test` files are migration debt, not a pattern to copy.
- **Redis up first:** `bun run start:redis`. Integration tests connect to
  `STREAMERSON_REDIS_HOST`/`STREAMERSON_REDIS_PORT` (default `localhost:6379`) via
  the harness `REDIS` config — never hardcode a connection in a test body.
- **Placement:** tests live in the owning package (`packages/<name>/test/` or
  `src/tests/`), named by the behavior under test (`cross-member-reclaim.test.ts`,
  `poison-crash-loop.test.ts`) — the filename is the spec clause's title.
- **Slow tests:** long-running load/conservation suites carry the `.slow.test.ts`
  suffix so the fast feedback loop stays fast; they still run in full verification.
- **Test names read as spec sentences.** `it('reclaims a message abandoned by a
  crashed member within min-idle', ...)` — someone reading only the test names should
  be able to reconstruct the contract. That is what "living spec" means.
- **Layering applies to tests too:** a package's tests may use lower layers
  (`consumer` tests use `core`) but never reach upward.
