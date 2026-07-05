/**
 * Ownership suite (TEST_PLAN.md §4 "3.6"; BEHAVIOR_AUDIT.md 3.6; resolved decision
 * D14: registry-key NX ownership claim at connect IS the spec — an owner asserts
 * `SET owner:<key> <machineId> NX` when it connects, and a SECOND claimant over the
 * same keys fails loudly).
 *
 * STATUS: D14 is IMPLEMENTED (stream-state-machine.ts claimOwnership: at
 * connectAndListen an owner asserts `SET owner:<topic-consumer-key>:<derived-key>
 * <machineId> NX` per owner-configured state key; claims are released with DEL on
 * clean disconnect — the documented-minimal liveness strategy, so a CRASHED owner
 * leaves a stale claim pending a future TTL lease). Registry naming: the claim key is
 * TOPIC-SCOPED (the machine's stream identity) — the decision's literal `owner:<key>`
 * shape would make every machine anywhere contest a same-named logical state key;
 * `claimKeyFor` below is the single edit point encoding the implemented shape.
 *
 * Two tests:
 *  - I-O1 — KEPT as a GREEN documentary HAZARD PIN, reworked in scope: D14 is a
 *    MACHINE/connect-time contract, and bare `CacheableDataSource` writers bypass it
 *    entirely — two datasource-altitude owner writers over one physical key still
 *    silently lose updates (three interleaved incrs leave Redis at 2). This remains
 *    the recorded hazard the machine-level claim exists to prevent.
 *  - D14 spec — GREEN: first owner's claim visible in Redis after connect; a second
 *    owner over the same topic/shard/state keys is refused loudly and intelligibly
 *    (the regression guard that absorbed the former I-O1 dual-owner scenario and
 *    SUPERSEDED the claim-absence pin, removed with the fix).
 *
 * Note: no handlers are registered on any machine here — handler registration is
 * independently broken (streamEvents field wipe, see lifecycle-contract.test.ts) and
 * ownership claims are a connect-time contract, not a dispatch-time one.
 *
 * Live Redis required. Run: bun test packages/state-machine/test/ownership.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import type { Topic } from '@streamerson/core';
import type { StreamStateMachine } from '../src/stream-state-machine';
import {
  assertGateOrSkip, testRig, makeDatasource, makeMachine,
  awaitReplicated, expectedKeyFor,
} from './harness';

/** The implemented D14 registry-key shape (single edit point, per the suite header). */
function claimKeyFor(machine: StreamStateMachine<any>, topic: Topic, stateKey: string): string {
  return `owner:${topic.consumerKey()}:${expectedKeyFor(machine, stateKey, stateKey)}`;
}

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const gated = describe.skipIf(!assertGateOrSkip());

gated('3.6 ownership', () => {
  it('I-O1 hazard pin: two owner:true/replicated:true writers over one key lose updates — three interleaved incrs leave Redis at 2 (last-writer-wins value clobbering)', async () => {
    const ks = rig.keyspace('own-io1');
    const conf: StateConfiguration = { type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true };
    const a = await makeDatasource(rig, { name: 'own-io1-a' });
    const b = await makeDatasource(rig, { name: 'own-io1-b' });
    const key = ks.key('counter');

    // Sequenced so each cold hydration sees the previous owner's replicated value
    // (awaitReplicated between steps keeps the pin deterministic).
    expect(await a.incr({ key }, conf)).toBe(1); // a hydrates absent → 1
    await awaitReplicated(rig.observer, key, '1');
    expect(await b.incr({ key }, conf)).toBe(2); // b hydrates '1' → 2
    await awaitReplicated(rig.observer, key, '2');
    // a is already hydrated and locally authoritative at 1 — it never sees b's
    // write: its incr answers 2 and its value replication clobbers Redis back to
    // '2'. Three increments happened; the counter reads 2. The lost update is the
    // hazard D14's claim registry exists to prevent.
    expect(await a.incr({ key }, conf)).toBe(2);
    await awaitReplicated(rig.observer, key, '2');

    // Part of the pin: D14 is a machine/connect-time contract — plain datasource
    // writers assert no registry claim, which is exactly why this hazard persists at
    // this altitude.
    expect(await rig.observer.exists(`owner:${key}`)).toBe(false);
  });

  // (The former claim-absence pin — "connect leaves no ownership claim" — was
  // SUPERSEDED by the D14 spec below and removed with the fix, as it prescribed.)

  it('D14 spec: the first owner asserts a registry claim at connect and a second owner over the same keys fails loudly', async () => {
    const stateKey = `owned_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const stateConfigurations: Record<string, StateConfiguration> = {
      [stateKey]: { type: StateObjectTypes.StandaloneNumber, owner: true, replicated: true },
    };
    const topic = rig.topic('own-d14');
    const shard = 'shard-d14';

    const { machine: first } = await makeMachine(rig, { tag: 'own-d14-a', topic, shard, stateConfigurations });

    // Minimum observable of the claim: after the first owner's connect resolves,
    // `SET <claimKey> <machineId> NX` has landed and names the claimant.
    const claimKey = claimKeyFor(first, topic, stateKey);
    rig.onTeardown(async () => { await rig.observer.del(claimKey); });
    expect(await rig.observer.exists(claimKey)).toBe(true);
    expect(await rig.observer.get(claimKey)).toBe(first.machineId);

    // The second claimant — identical topic, shard, and owned state keys — must fail
    // loudly AND intelligibly at connect (NX claim already held): the error names the
    // contested state key, the registry key, and the holding machine.
    const { machine: second } = await makeMachine(rig, {
      tag: 'own-d14-b', topic, shard, stateConfigurations, connect: false,
    });
    await expect(second.connectAndListen()).rejects.toThrow(
      new RegExp(`Ownership claim rejected for state '${stateKey}'.*already held by machine '${first.machineId}'`),
    );
  });
});
