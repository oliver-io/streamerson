/**
 * Ticker-tape full loop (TEST_PLAN.md §2 item 1.1; BEHAVIOR_AUDIT.md 1.1 — GREEN pins).
 *
 * The state machine is a StreamConsumer whose handlers receive the state-transformer
 * map as arg 1 and whose return value comes back as a correlated 'resp' message on the
 * producer stream (stream-state-machine.ts `_handle_message`). These tests drive that
 * loop through the public surface only: a message injected on the consumer stream is
 * the stimulus; the correlated response and Redis ground truth (out-of-band observer)
 * are the oracles. Handlers prove arg 1 is the transformer map BY USING it.
 *
 * Requires Redis (`bun run start:redis`).
 *
 * FINDING (run 2026-07-03, bun 1.3.14): all three tests land RED at `makeMachine` —
 * a NEW product defect, not a wrong audit belief. The declaration-only
 * `override streamEvents` field (stream-state-machine.ts:28) is compiled with DEFINE
 * semantics by Bun (which ignores tsconfig target/useDefineForClassFields — verified
 * with a minimal repro), so after `super()` the base's `streamEvents = {}` is
 * clobbered to `undefined` and every `registerStreamEvent` throws
 * `TypeError: undefined is not an object`. No handler can EVER be registered under
 * Bun (the constructor eventMap path is wiped the same way). Tests stay asserting
 * the spec; they flip GREEN when the field gets an initializer (or the declaration
 * is dropped) in product source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
// StateObjectTypes is not re-exported from core's index (known export gap) — subpath
// import, matching construct.gate.test.ts.
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip, testRig, makeMachine, write, awaitResponse,
  awaitReplicated, expectedKeyFor,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const stateConfigurations: Record<string, StateConfiguration> = {
  // owner+replicated: the write returns locally and replicates fire-and-forget, so
  // ground truth is observed via awaitReplicated (poll-to-convergence), per plan §1.6.
  counters: { type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true },
};

const gated = describe.skipIf(!assertGateOrSkip());

gated('ticker-tape full loop (1.1)', () => {
  it('a: an injected message reaches the handler with the transformer map as arg 1, whose set() lands in Redis, and the return value round-trips as a correlated resp', async () => {
    const ks = rig.keyspace('tape-happy');
    const target = ks.key('greeting');
    const { machine, topic } = await makeMachine(rig, {
      tag: 'tape-happy',
      stateConfigurations,
      handlers: {
        // Proves arg 1 is the transformer map by USING it — not by inspecting shape.
        poke: async (state, payload) => {
          const wrote = await state.counters.set(target, payload.value);
          return { echoed: payload.value, wrote };
        },
      },
    });

    await write(rig.admin, topic, 'poke', 'tape-happy-1', { value: 'hello-tape' });
    const resp = await awaitResponse(topic, 'tape-happy-1', 8000);

    expect(resp).toBeDefined();
    expect(resp!.messageType).toBe('resp');
    expect(resp!.payload).toEqual({ echoed: 'hello-tape', wrote: true });
    // Ground truth: the handler's set() really landed on the physical key, computed
    // the public way (never a hardcoded string).
    await awaitReplicated(rig.observer, expectedKeyFor(machine, 'counters', target), 'hello-tape');
  }, 15000);

  it('b: an unknown message type yields no response within a bounded window and the machine stays live for the next valid message', async () => {
    const ks = rig.keyspace('tape-unknown');
    const target = ks.key('alive');
    const { topic } = await makeMachine(rig, {
      tag: 'tape-unknown',
      stateConfigurations,
      handlers: {
        poke: async (state, payload) => {
          await state.counters.set(target, payload.value);
          return { ok: true };
        },
      },
    });

    await write(rig.admin, topic, 'no-such-type', 'tape-unknown-1', { value: 'ignored' });
    // Negative window: absence cannot be polled to convergence, so we give the
    // forbidden response a bounded 800ms to appear — several times the observed
    // healthy round-trip latency (well under 200ms on this rig) — then assert absence.
    const forbidden = await awaitResponse(topic, 'tape-unknown-1', 800);
    expect(forbidden).toBeUndefined();

    // Liveness: the very next valid message is still answered.
    await write(rig.admin, topic, 'poke', 'tape-unknown-2', { value: 'still-alive' });
    const resp = await awaitResponse(topic, 'tape-unknown-2', 8000);
    expect(resp).toBeDefined();
    expect(resp!.payload).toEqual({ ok: true });
  }, 15000);

  it('c: bridge — a handler that incrs twice reports 2 in its response and Redis converges to "2"', async () => {
    const ks = rig.keyspace('tape-bridge');
    const target = ks.key('bumped');
    const { machine, topic } = await makeMachine(rig, {
      tag: 'tape-bridge',
      stateConfigurations,
      handlers: {
        bump: async (state) => {
          await state.counters.incr(target);
          const count = await state.counters.incr(target);
          return { count };
        },
      },
    });

    await write(rig.admin, topic, 'bump', 'tape-bridge-1', {});
    const resp = await awaitResponse(topic, 'tape-bridge-1', 8000);

    expect(resp).toBeDefined();
    expect(resp!.payload).toEqual({ count: 2 });
    // The bridge: local answer (owner-fast-path) and remote ground truth agree.
    await awaitReplicated(rig.observer, expectedKeyFor(machine, 'counters', target), '2');
  }, 15000);
});
