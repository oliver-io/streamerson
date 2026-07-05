/**
 * Lifecycle & handler-contract suite (TEST_PLAN.md §3 "2.13"; BEHAVIOR_AUDIT.md 2.13;
 * resolved decision D-2.13: the state-machine handler convention
 * `(stateTransformers, payload, { sourceId })` is CANONICAL — eventMap registration
 * and cluster wrapping must preserve it).
 *
 * 2.13-A (spec, canonical convention):
 *   A handler passed via the constructor's `eventMap`, driven by a REAL message
 *   round-trip, must receive `(stateTransformers, payload, { sourceId })`. GREEN:
 *   the historical `streamEvents` define-semantics wipe is fixed (`declare` on the
 *   override, stream-state-machine.ts).
 *
 * 2.13-A (fork, cluster path):
 *   The same-shaped handler driven through the cluster's `wrapHandlers`
 *   (consumer/src/cluster-member.ts, inside `runClusterMember`) must STILL receive
 *   the canonical triple. GREEN since the D-2.13 fix: `wrapHandlers` is
 *   signature-preserving (`(...args) => original(...args)`), so the state machine's
 *   `_handle_message` three-arg dispatch survives the processingTimeout wrap.
 *   Surface gap on record: a state machine cannot be reconstructed from clone-safe
 *   `MemberParams` (stateConfigurations/eventMap carry functions), so the honest
 *   factory must close over a pre-built machine.
 *
 * 2.13-B (connection accounting, regression guard):
 *   GREEN today — and possibly GREEN *by accident*: the transfer channel's two
 *   `StreamingDataSource`s are closed over inside `streamAwaiter` and are never
 *   `connect()`ed by current code (audit 2.4), so `disconnect()`'s failure to close
 *   them leaks nothing YET. This test is the regression guard that catches the leak
 *   the moment 2.4's fix connects them: CLIENT LIST must return to baseline after
 *   `disconnect()`. Attribution note: Bun's test runner executes files serially in
 *   one process and this file's other machines stay connected across this test, so a
 *   whole-server count diff is stable; if the runner ever parallelizes files, this
 *   test must move to strict name-filtering or a serial-only lane.
 *
 * Live Redis required. Run: bun test packages/state-machine/test/lifecycle-contract.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import { runClusterMember } from '@streamerson/consumer';
import type { MemberParams } from '@streamerson/consumer';
import { StreamStateMachine } from '../src/stream-state-machine';
import type { StateConfiguration } from '../src/types';
import { assertGateOrSkip, testRig, REDIS, quietLogger, write, until, sleep } from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const stateConfigurations: Record<string, StateConfiguration> = {
  counters: { type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true },
};

type Captured = { state: any; payload: any; meta: any };

/** A machine constructed DIRECTLY (not via makeMachine) so the handler enters through
 * the constructor's `eventMap` — the registration path 2.13-A pins.
 *
 * Teardown is a BOUNDED closer rather than `rig.track`: `disconnect()` on a machine
 * that never reached `connectAndListen` HANGS FOREVER, and so does a SECOND
 * `disconnect()` after a successful one (new findings, empirically pinpointed:
 * `StateCache.disconnect` → `endCacheListener` issues `unsubscribe` on a
 * not-open node-redis client, which queues the command until a connect that never
 * comes — state-cache.ts:41 / cacheable.ts:242). The fork test can legitimately
 * leave its machine cold, and Test B disconnects in-test, so an unbounded tracked
 * disconnect would wedge the rig. */
function boundedTrack<T extends { disconnect(): Promise<unknown> | void }>(subject: T): T {
  rig.onTeardown(async () => {
    await Promise.race([
      Promise.resolve(subject.disconnect()).catch(() => { /* */ }),
      sleep(2000), // bound: cold/double disconnect hangs forever (see doc above)
    ]);
  });
  return subject;
}

function machineWithEventMap(tag: string, onInvoke: (c: Captured) => void) {
  const topic = rig.topic(tag);
  const machine = boundedTrack(new StreamStateMachine<any>({
    topic,
    redisConfiguration: { host: REDIS.host, port: REDIS.port },
    bidirectional: true,
    logger: quietLogger,
    stateConfigurations,
    eventMap: {
      compute: (async (state: any, payload: any, meta: any) => {
        onInvoke({ state, payload, meta });
        return { ok: 1 };
      }) as any,
    },
  } as any));
  return { machine, topic };
}

const gated = describe.skipIf(!assertGateOrSkip());

gated('2.13-A handler contract: the canonical convention is (stateTransformers, payload, { sourceId }) [D-2.13]', () => {
  it('an eventMap handler driven by a real round-trip receives the transformer map, the payload, and the sourceId', async () => {
    let captured: Captured | undefined;
    const { machine, topic } = machineWithEventMap('lc-contract', (c) => { captured = c; });
    await machine.connectAndListen();

    await write(rig.admin, topic, 'compute', 'msg-lc-contract-1', { x: 1 });
    const invoked = await until(() => captured !== undefined, 5000);
    if (!invoked) {
      throw new Error(
        'eventMap handler was never invoked by a real message. Diagnostic: machine.streamEvents is ' +
        ((machine as any).streamEvents === undefined
          ? 'UNDEFINED — the subclass `override streamEvents` field declaration (stream-state-machine.ts:28) wiped the base registration under Bun define-field semantics; the eventMap registration was lost at construction.'
          : `an object with keys [${Object.keys((machine as any).streamEvents).join(', ')}]`),
      );
    }


    // The canonical contract (D-2.13): arg1 is the transformer map …
    expect(typeof captured!.state?.getClient).toBe('function');
    expect(typeof captured!.state?.counters?.incr).toBe('function');
    expect(typeof captured!.state?.counters?.set).toBe('function');
    // … arg2 is the (parsed) payload …
    expect(captured!.payload?.x).toBe(1);
    // … arg3 carries the message source.
    expect(typeof captured!.meta?.sourceId).toBe('string');
  }, 15_000); // own budget: the 5s until-poll plus diagnostics must not race bun's default test timeout

  it('the same-shaped handler driven through the cluster wrapHandlers path still receives the canonical triple', async () => {
    let captured: Captured | undefined;
    const { machine, topic } = machineWithEventMap('lc-fork', (c) => { captured = c; });

    // Honest drive of the exported cluster surface: runClusterMember installs a
    // command receiver on `self.onmessage`; we deliver the exact ClusterCommand the
    // coordinator would post. The factory closes over the pre-built machine because
    // MemberParams is clone-safe-only and cannot describe a state machine (surface gap).
    const params: MemberParams = {
      connectionSettings: {
        topic: { namespace: 'itest', topic: `lc-fork-${Date.now()}` },
        redisConfiguration: { host: REDIS.host, port: REDIS.port },
        bidirectional: true,
      },
      memberSettings: { groupId: 'lc-fork-group', groupMemberId: 'lc-fork-m1' },
      processingTimeout: 10_000,
      idleTimeout: 1_000,
    };
    const prevOnMessage = (self as any).onmessage;
    runClusterMember((() => machine) as any);
    const dispatch = (self as any).onmessage;
    (self as any).onmessage = prevOnMessage;
    try {
      await dispatch({ data: { type: 'start', params } });
    } catch {
      // Main-thread postMessage may reject the 'ready' signal after connectAndListen
      // succeeded; the machine is live and wrapped either way.
    }

    await write(rig.admin, topic, 'compute', 'msg-lc-fork-1', { x: 1 });
    const invoked = await until(() => captured !== undefined, 5000);
    expect(invoked).toBe(true);

    // Spec (D-2.13): cluster wrapping preserves the canonical triple.
    expect(typeof captured!.state?.getClient).toBe('function');
    expect(captured!.payload?.x).toBe(1);
    expect(typeof captured!.meta?.sourceId).toBe('string');
  }, 15_000);
});

gated('2.13-B connection accounting: disconnect() releases every connection the machine opened', () => {
  it('CLIENT LIST returns to baseline after disconnect() (regression guard for the 2.4-fix transfer-channel leak)', async () => {
    const baseline = (await rig.observer.clientList()).length;

    // No handlers registered: registerStreamEvent throws today (streamEvents wipe,
    // see 2.13-A) and this test's subject is the connection lifecycle, not dispatch.
    // Constructed directly with a BOUNDED teardown closer (not makeMachine/rig.track):
    // this test disconnects in-test, and a second disconnect() hangs forever (see
    // boundedTrack doc above).
    const machine = boundedTrack(new StreamStateMachine<any>({
      topic: rig.topic('lc-connclose'),
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
      bidirectional: true,
      logger: quietLogger,
      stateConfigurations,
    } as any));
    await machine.connectAndListen();

    const connected = (await rig.observer.clientList()).length;
    const delta = connected - baseline;
    // Observed connection footprint today: incoming + outgoing Bun stream channels
    // plus the state cache's three node-redis clients (client/cached/invalidation);
    // the transfer channel's two datasources never connect (audit 2.4).
    expect(delta).toBeGreaterThan(0);

    await machine.disconnect();

    const returned = await until(async () => (await rig.observer.clientList()).length === baseline, 5000);
    if (!returned) {
      const now = (await rig.observer.clientList()).length;
      throw new Error(
        `connection leak: CLIENT LIST did not return to baseline after disconnect() ` +
        `(baseline=${baseline}, after connect=${connected} [delta=${delta}], after disconnect=${now}). ` +
        'If delta-now-baseline === 2, suspect the transfer channel datasources (audit 2.13/2.4).',
      );
    }
    expect((await rig.observer.clientList()).length).toBe(baseline);
  });
});
