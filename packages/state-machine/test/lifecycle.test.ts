/**
 * Lifecycle: connect/disconnect choreography (TEST_PLAN.md §2 item 1.6;
 * BEHAVIOR_AUDIT.md 1.6 — GREEN pins).
 *
 * `connectAndListen` runs the consumer's stream listen and `StateCache.connect`
 * concurrently; `disconnect` quits both halves. These tests assert the observable
 * consequences only: (a) after connect, a state op reaches Redis AND a message
 * round-trips; (b) after disconnect, an injected message gets no response. This is
 * the WEAKENED form on purpose — strict CLIENT LIST connection accounting belongs to
 * the 2.13 lifecycle-contract suite, not here.
 *
 * Requires Redis (`bun run start:redis`).
 *
 * FINDING (run 2026-07-03, bun 1.3.14): both tests land RED at `makeMachine` on a
 * NEW product defect — Bun compiles the declaration-only `override streamEvents`
 * field (stream-state-machine.ts:28) with define semantics, clobbering the base's
 * `{}` to `undefined`; `registerStreamEvent` throws. See ticker-tape-loop.test.ts
 * header for the full analysis. Tests stay asserting the spec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
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
  counters: { type: StateObjectTypes.StandaloneString, owner: true, replicated: true },
};

const gated = describe.skipIf(!assertGateOrSkip());

gated('lifecycle (1.6)', () => {
  it('a: connectAndListen enables both halves — a handler state op reaches Redis and the message round-trips', async () => {
    const ks = rig.keyspace('lifecycle-connect');
    const target = ks.key('mark');
    const { machine, topic } = await makeMachine(rig, {
      tag: 'lifecycle-connect',
      stateConfigurations,
      handlers: {
        touch: async (state, payload) => {
          // Uses the state half (StateCache / cachedChannel)...
          await state.counters.set(target, payload.value);
          return { touched: true };
        },
      },
    });

    // ...through the message half (incoming/outgoing stream channels):
    await write(rig.admin, topic, 'touch', 'lifecycle-connect-1', { value: 'connected' });
    const resp = await awaitResponse(topic, 'lifecycle-connect-1', 8000);
    expect(resp).toBeDefined();
    expect(resp!.messageType).toBe('resp');
    expect(resp!.payload).toEqual({ touched: true });
    await awaitReplicated(rig.observer, expectedKeyFor(machine, 'counters', target), 'connected');
  }, 15000);

  it('b: after disconnect() an injected message receives no response within a bounded window', async () => {
    const ks = rig.keyspace('lifecycle-disconnect');
    const target = ks.key('mark');
    const { machine, topic } = await makeMachine(rig, {
      tag: 'lifecycle-disconnect',
      stateConfigurations,
      handlers: {
        touch: async (state, payload) => {
          await state.counters.set(target, payload.value);
          return { touched: true };
        },
      },
    });

    // Prove the loop is live BEFORE disconnecting, so the negative below can only
    // mean "disconnect quiesced it", never "it was never wired".
    await write(rig.admin, topic, 'touch', 'lifecycle-disconnect-live', { value: 'pre' });
    expect((await awaitResponse(topic, 'lifecycle-disconnect-live', 8000))?.payload).toEqual({ touched: true });

    await machine.disconnect();

    // Negative-window rationale: quiescence is an ABSENCE, which cannot be polled to
    // convergence — so we grant the forbidden response a bounded 1000ms window,
    // several times the healthy round-trip latency demonstrated moments ago on this
    // very machine (<~200ms), then assert nothing arrived. Strict connection
    // accounting (CLIENT LIST back to baseline) is 2.13's, not this test's.
    await write(rig.admin, topic, 'touch', 'lifecycle-disconnect-dead', { value: 'post' });
    const forbidden = await awaitResponse(topic, 'lifecycle-disconnect-dead', 1000);
    expect(forbidden).toBeUndefined();
  }, 15000);
});
