/**
 * Payload unwrapping (TEST_PLAN.md §2 item 1.7; BEHAVIOR_AUDIT.md 1.7 — GREEN pins).
 *
 * These tests PIN the double-unwrap workaround in the `registerStreamEvent` override
 * (stream-state-machine.ts:146-153) — they do NOT endorse it. It compensates for a
 * known upstream serialization inconsistency (messages sometimes arrive on the wire
 * stringified more than once); the real fix belongs upstream, and when it lands these
 * pins are the tests that flip consciously.
 *
 * Wire mechanics (verified against core): the read path parses `messageProtocol:
 * 'json'` payloads once (core/src/datasource/streamable.ts:176-178), so a canonically
 * written message reaches the handler wrapper ALREADY an object — the wrapper's
 * string branch fires only for a doubly-encoded wire payload. Test (c) is the
 * decide-from-evidence object-passthrough pin that records this.
 *
 * Handlers go through the public `registerStreamEvent` ONLY (the eventMap
 * constructor fork is the 2.13 suite's territory). Oracle: the handler echoes
 * `typeof` and a payload field into its response, observed on the producer stream.
 *
 * Requires Redis (`bun run start:redis`).
 *
 * FINDING (run 2026-07-03, bun 1.3.14): all three tests land RED at `makeMachine`
 * on a NEW product defect — Bun compiles the declaration-only `override
 * streamEvents` field (stream-state-machine.ts:28) with define semantics,
 * clobbering the base's `{}` to `undefined`; `registerStreamEvent` throws. See
 * ticker-tape-loop.test.ts header for the full analysis. Tests stay asserting the
 * spec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { MessageType } from '@streamerson/core';
import type { Topic } from '@streamerson/core';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip, testRig, makeMachine, write, awaitResponse,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const stateConfigurations: Record<string, StateConfiguration> = {
  scratch: { type: StateObjectTypes.StandaloneString, owner: true, replicated: true },
};

/** The probe handler's echo: what did the payload look like when it reached user code? */
const probeHandlers = {
  probe: async (_state: any, payload: any) => ({
    kind: typeof payload,
    marker: payload?.marker ?? null,
    nested: payload?.deep?.value ?? null,
  }),
};

/** Suite-local raw injection with an EXPLICIT wire string — lets a test control how
 * many times the payload was stringified before hitting the stream (the harness
 * `write` always stringifies exactly once). */
async function writeRaw(topic: Topic, messageId: string, wirePayload: string): Promise<void> {
  await rig.admin.writeToStream({
    outgoingStream: topic.consumerKey(),
    incomingStream: topic.producerKey(),
    messageType: 'probe' as MessageType,
    messageId,
    message: wirePayload,
    sourceId: 'test',
  });
}

const gated = describe.skipIf(!assertGateOrSkip());

gated('payload unwrap (1.7)', () => {
  it('a: a single-stringified wire payload reaches the handler as a parsed object', async () => {
    const { topic } = await makeMachine(rig, { tag: 'unwrap-single', stateConfigurations, handlers: probeHandlers });

    // Canonical single stringify on the wire (what the harness/gateways produce).
    await writeRaw(topic, 'unwrap-single-1', JSON.stringify({ marker: 'one', deep: { value: 'kept' } }));
    const resp = await awaitResponse(topic, 'unwrap-single-1', 8000);

    expect(resp).toBeDefined();
    expect(resp!.payload).toEqual({ kind: 'object', marker: 'one', nested: 'kept' });
  }, 15000);

  it('b: a double-stringified wire payload is unwrapped to a parsed object (pins the stream-state-machine.ts:146-153 workaround)', async () => {
    const { topic } = await makeMachine(rig, { tag: 'unwrap-double', stateConfigurations, handlers: probeHandlers });

    // Doubly encoded: core's reader parses once and yields a STRING; the state
    // machine's registerStreamEvent wrapper must parse again before the handler.
    await writeRaw(topic, 'unwrap-double-1', JSON.stringify(JSON.stringify({ marker: 'two', deep: { value: 'kept' } })));
    const resp = await awaitResponse(topic, 'unwrap-double-1', 8000);

    expect(resp).toBeDefined();
    expect(resp!.payload).toEqual({ kind: 'object', marker: 'two', nested: 'kept' });
  }, 15000);

  it('c: object passthrough — a canonically written payload arrives pre-parsed by core and passes through the unwrap untouched, structure intact', async () => {
    // Decide-from-evidence pin (plan 1.7c): (a) already shows payloads arrive as
    // objects because core parses `messageProtocol: 'json'` once on read; this pin
    // records that the state-machine wrapper does not re-stringify, lossily clone,
    // or otherwise disturb an already-parsed object on its way to the handler.
    const { topic } = await makeMachine(rig, {
      tag: 'unwrap-passthrough',
      stateConfigurations,
      handlers: {
        probe: async (_state: any, payload: any) => ({
          kind: typeof payload,
          marker: payload?.marker ?? null,
          nested: payload?.deep?.value ?? null,
          listLength: Array.isArray(payload?.list) ? payload.list.length : -1,
          numberKept: payload?.count === 3,
        }),
      },
    });

    await write(rig.admin, topic, 'probe', 'unwrap-pass-1', {
      marker: 'three', deep: { value: 'kept' }, list: ['a', 'b'], count: 3,
    });
    const resp = await awaitResponse(topic, 'unwrap-pass-1', 8000);

    expect(resp).toBeDefined();
    expect(resp!.payload).toEqual({
      kind: 'object', marker: 'three', nested: 'kept', listLength: 2, numberKept: true,
    });
  }, 15000);
});
