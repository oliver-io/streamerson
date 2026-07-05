/**
 * Wire suite (TEST_PLAN.md §3 items 2.4 / 2.8 / 2.12, plus the §4 3.1 dispatch-side
 * pin): what the state machine actually puts on (or fails to put on) the wire.
 *
 * STATUS: the 2.4 / 2.8 / 2.12 fixes have landed — every spec clause here is GREEN
 * and the defect PINs (2.4a, 2.4b, 2.8, 2.12) are RETIRED (each replaced by its
 * successor spec clause, noted in place).
 *
 * Scope note (D-Transfer, TEST_PLAN §6): the transfer receive side is decided
 * (durable-ack + rollback) but NOT tested here — transfer is dispatch-and-return for
 * now (the durable-ack deferral is never awaited; entry-appears is the contract).
 *
 * Requires Redis (`bun run start:redis`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { shardDecorator, Topic } from '@streamerson/core';
// StateObjectTypes / the runtime MessageType enum are not re-exported from core's
// index (known export gap; see construct.gate.test.ts) — subpath import required.
import { MessageType, StateObjectTypes } from '@streamerson/core/src/types';
import { StreamConsumer } from '@streamerson/consumer';
import { StreamStateMachine } from '../src/stream-state-machine';
import type { StateConfiguration } from '../src/types';
import {
  REDIS,
  assertGateOrSkip,
  makeMachine,
  quietLogger,
  readEntries,
  sleep,
  testRig,
  until,
} from './harness';

const stateConfigurations: Record<string, StateConfiguration> = {
  counters: { type: StateObjectTypes.StandaloneString, owner: true, replicated: true },
};

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

/**
 * The transfer stream a dispatch targets, computed the PUBLIC way: shardDecorator
 * over the topic's consumer key plus the TARGET shard, suffixed
 * '::incoming_state_transfer'. (TEST CORRECTION with the 2.4 fix: this helper
 * originally derived with the DISPATCHER's own shard — that is the machine's mirror
 * receive stream, not where a transfer must land. The spec-faithful target is the
 * shardTarget's stream; the receiving machine's constructor derives its
 * `incomingStream` the same way with its own shard.)
 */
function transferStreamKey(topic: Topic, shardTarget?: string): string {
  return `${shardDecorator({ key: topic.consumerKey(), shard: shardTarget })}::incoming_state_transfer`;
}

/** Every transfer call is raced against a deadline — transfer is specified as
 * dispatch-and-return (D-Transfer interim: no receive side yet), so a hang is itself
 * a spec violation this bound surfaces. */
async function boundedTransfer(
  machine: StreamStateMachine<any>,
  stateKey: string,
  propertyTarget: string,
  shardTarget: string,
  deadlineMs = 3000,
): Promise<{ outcome: 'resolved' | 'rejected' | 'deadline'; error?: Error; value?: unknown }> {
  const call = (machine.stateTransformers as any)[stateKey]
    .transfer(propertyTarget, shardTarget)
    .then((value: unknown) => ({ outcome: 'resolved' as const, value }))
    .catch((error: Error) => ({ outcome: 'rejected' as const, error }));
  return await Promise.race([call, sleep(deadlineMs).then(() => ({ outcome: 'deadline' as const }))]);
}

/** An unsharded owner machine with one replicated scalar already locally held (SET
 * through the public transformer), so transfer's has() precondition passes. */
async function ownerHoldingState(tag: string) {
  const ks = rig.keyspace(tag);
  const { machine, topic } = await makeMachine(rig, { tag, stateConfigurations });
  rig.onTeardown(async () => {
    try { await rig.admin.client.send('DEL', [transferStreamKey(topic, 'shardB'), transferStreamKey(topic)]); } catch { /* */ }
  });
  const key = ks.key('counter');
  await (machine.stateTransformers as any).counters.set(key, '42');
  return { machine, topic, key };
}

const gated = describe.skipIf(!assertGateOrSkip());

gated('wire: state transfer dispatch (audit 2.4 + 3.1 dispatch pin)', () => {
  // PIN(2.4a) — the awaiter no-target throw — RETIRED with the 2.4 fix: dispatch now
  // targets the shardTarget's transfer stream. Its successor spec clause:
  it('transfer of locally-held state settles (dispatch-and-return, D-Transfer interim) resolving true within the deadline', async () => {
    const { machine, key } = await ownerHoldingState('xfer-settle');
    const result = await boundedTransfer(machine, 'counters', key, 'shardB');
    expect(result.outcome).toBe('resolved');
    expect(result.value).toBe(true);
  });

  /**
   * Spec clause (BEHAVIOR_AUDIT.md 2.4; carries the 3.1 dispatch-side pin; GREEN
   * since the 2.4 fix): transfer(K, shardB) places exactly one entry on the TARGET
   * shard's transfer stream, typed with the protocol's real TRANSFER wire value
   * ('xfer', core/src/types.ts:11) and carrying the {stateType, stateData} envelope.
   * Entry-appears only — the durable-ack deferral is future work per D-Transfer.
   */
  it('transfer of locally-held state places exactly one xfer-typed {stateType, stateData} entry on the target shard\'s transfer stream', async () => {
    const { machine, topic, key } = await ownerHoldingState('xfer-spec');
    const stream = transferStreamKey(topic, 'shardB');
    void (await boundedTransfer(machine, 'counters', key, 'shardB'));
    await until(async () => (await readEntries(rig.admin, stream)).length > 0, 2000);
    const entries = await readEntries(rig.admin, stream);
    expect(entries.length).toBe(1);
    expect(entries[0]!['messageType']).toBe('xfer');
    const envelope = JSON.parse(entries[0]!['payload']!);
    expect(envelope).toEqual({ stateType: 'counters', stateData: '42' });
  });

  // PIN(2.4b) — "the transfer channel contributes zero connections (never connected)"
  // — RETIRED: the write channel now connects LAZILY on first transfer. Successor
  // clause: lazy connect + disconnect() releases it (the 2.13-B regression guard's
  // transfer-channel case, exercised here where a transfer actually happens).
  it('the transfer write channel connects lazily on first transfer and disconnect() releases it (CLIENT LIST returns to baseline)', async () => {
    const baseline = (await rig.observer.clientList()).length;
    const topic = rig.topic('xfer-conns');
    const ks = rig.keyspace('xfer-conns');
    const machine = new StreamStateMachine<any>({
      topic,
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
      bidirectional: true,
      logger: quietLogger,
      stateConfigurations,
    } as any);
    // Bounded teardown (see lifecycle-contract.test.ts boundedTrack rationale): this
    // test disconnects in-test and a second disconnect() hangs forever.
    rig.onTeardown(async () => {
      await Promise.race([Promise.resolve(machine.disconnect()).catch(() => { /* */ }), sleep(2000)]);
      try { await rig.admin.client.send('DEL', [transferStreamKey(topic, 'shardB')]); } catch { /* */ }
    });
    await machine.connectAndListen();
    const connected = (await rig.observer.clientList()).length;

    const key = ks.key('counter');
    await (machine.stateTransformers as any).counters.set(key, '1');
    const result = await boundedTransfer(machine, 'counters', key, 'shardB');
    expect(result.outcome).toBe('resolved');
    // Lazy connect: the first transfer opened the write channel's one connection.
    const afterTransfer = (await rig.observer.clientList()).length;
    expect(afterTransfer).toBe(connected + 1);

    await machine.disconnect();
    const returned = await until(async () => (await rig.observer.clientList()).length === baseline, 5000);
    expect(returned).toBe(true);
  });
});

gated('wire: broadcast message typing (audit 2.8)', () => {
  /**
   * Spec clause (BEHAVIOR_AUDIT.md 2.8; GREEN since the fix): a broadcast entry is
   * typed with the protocol's real BROADCAST wire value ('xcast',
   * core/src/types.ts:16), not the enum NAME.
   */
  it('broadcast writes an entry whose messageType is the protocol wire value xcast', async () => {
    const { machine } = await makeMachine(rig, { tag: 'xcast-spec', stateConfigurations });
    const ks = rig.keyspace('xcast-spec');
    const stream = ks.key('broadcast-stream');
    await (machine.stateTransformers as any).counters.broadcast(stream, { message: 'm' }, 'src');
    // Empirical landing check: broadcast passes the raw stream name as outgoingStream
    // with no shard, so writeToStream's shardDecorator is identity — the entry lands
    // on the raw name (verified below; a zero-entry read here would falsify that).
    await until(async () => (await readEntries(rig.admin, stream)).length > 0, 2000);
    const entries = await readEntries(rig.admin, stream);
    expect(entries.length).toBe(1);
    expect(entries[0]!['messageType']).toBe('xcast');
  });

  // PIN(2.8) — "the entry carries the enum NAME 'BROADCAST'" — RETIRED with the fix;
  // the spec test above owns the wire value.

  /**
   * Consequence clause (BEHAVIOR_AUDIT.md 2.8; GREEN since the fix): a broadcast is
   * consumable by a real StreamConsumer whose handler is registered under the real
   * MessageType.BROADCAST — the whole point of a typed wire value. The control write
   * (an 'xcast' entry via the admin channel) keeps the liveness proof so a failure
   * would implicate the wire value, not the consumer.
   */
  it('a StreamConsumer handler registered under MessageType.BROADCAST receives a machine broadcast', async () => {
    const received: string[] = [];
    const consumerTopic = rig.topic('xcast-consumer');
    const consumer = new StreamConsumer<any>({
      topic: consumerTopic,
      redisConfiguration: { host: REDIS.host, port: REDIS.port },
      bidirectional: true,
      logger: quietLogger,
    });
    consumer.registerStreamEvent(MessageType.BROADCAST, async (e: any) => {
      received.push(e.payload?.message ?? '?');
      return {};
    });
    rig.track(consumer);
    await consumer.connectAndListen();

    const { machine } = await makeMachine(rig, { tag: 'xcast-broadcaster', stateConfigurations });
    await (machine.stateTransformers as any).counters.broadcast(consumerTopic.consumerKey(), { message: 'm' }, 'src');

    // The spec assertion: the correctly-typed ('xcast') broadcast fires the handler.
    await until(() => received.includes('m'), 3000);
    expect(received).toContain('m');

    // Liveness control retained: an admin-written 'xcast' entry also fires.
    await rig.admin.writeToStream({
      outgoingStream: consumerTopic.consumerKey(),
      incomingStream: consumerTopic.producerKey(),
      messageType: MessageType.BROADCAST,
      messageId: 'xcast-control',
      message: JSON.stringify({ message: 'control' }),
      sourceId: 'test',
    });
    await until(() => received.includes('control'), 3000);
    expect(received).toContain('control');
  });
});

gated('wire: transfer precondition vs sharded keying (audit 2.12)', () => {
  /** A SHARDED owner machine holding K locally: the write path keys the LRU via
   * shardDecorator ('K#shard-a', cacheable.ts set), while transfer's has() checks the
   * raw key (cacheable.ts has → cache.has(options.key)). */
  async function shardedOwnerHoldingState(tag: string) {
    const ks = rig.keyspace(tag);
    const { machine, topic } = await makeMachine(rig, { tag, stateConfigurations, shard: 'shard-a' });
    rig.onTeardown(async () => {
      try { await rig.admin.client.send('DEL', [transferStreamKey(topic, 'shardB')]); } catch { /* */ }
    });
    const key = ks.key('counter');
    await (machine.stateTransformers as any).counters.set(key, '7');
    return { machine, topic, key };
  }

  /**
   * Spec clause (BEHAVIOR_AUDIT.md 2.12; GREEN since the fix): state the sharded
   * owner just wrote IS locally held — the precondition consults the same derived key
   * (cacheComposite + shardDecorator) the write path used — so transfer proceeds all
   * the way to entry-appears on the target's transfer stream. PIN(2.12) ("is not
   * locally held" despite locally-present state) RETIRED with the fix.
   */
  it('transfer of state a sharded owner locally holds passes the precondition and places the entry', async () => {
    const { machine, topic, key } = await shardedOwnerHoldingState('shard-precond-spec');
    const result = await boundedTransfer(machine, 'counters', key, 'shardB');
    expect(result.outcome).toBe('resolved');
    const stream = transferStreamKey(topic, 'shardB');
    await until(async () => (await readEntries(rig.admin, stream)).length > 0, 2000);
    const entries = await readEntries(rig.admin, stream);
    expect(entries.length).toBe(1);
    expect(JSON.parse(entries[0]!['payload']!)).toEqual({ stateType: 'counters', stateData: '7' });
  });

  /**
   * Sad-path intelligibility (A10): transferring a property that holds no state
   * anywhere rejects with an error naming the property target AND the derived key —
   * never the old 'counters::undefined' interpolation of the absent dataKey.
   */
  it('transfer of absent state rejects intelligibly, naming the property target and the derived key', async () => {
    const { machine } = await shardedOwnerHoldingState('shard-precond-absent');
    const missing = rig.keyspace('shard-precond-absent-missing').key('never-written');
    const result = await boundedTransfer(machine, 'counters', missing, 'shardB');
    expect(result.outcome).toBe('rejected');
    expect(result.error!.message).toContain(`'counters.${missing}'`);
    expect(result.error!.message).toContain(`'${missing}#shard-a'`); // the derived key (shardDecorator over cacheComposite)
    expect(result.error!.message).not.toContain('::undefined');
  });

  /**
   * Secondary 2.12 variant (audit spec: an owner may transfer state durable in Redis
   * even if locally evicted). With D-Hydration landed, the precondition read hydrates
   * a locally-cold owner key from Redis before deciding. Deterministic cold-cache
   * condition: seed Redis out-of-band for a key this machine has never touched.
   */
  it('transfer of durable-but-locally-cold owner state hydrates and places the entry', async () => {
    const { machine, topic } = await shardedOwnerHoldingState('shard-precond-cold');
    const ks = rig.keyspace('shard-precond-cold-durable');
    const coldKey = ks.key('cold-counter');
    await rig.observer.set(`${coldKey}#shard-a`, '99'); // ground truth: durable, never locally held
    const result = await boundedTransfer(machine, 'counters', coldKey, 'shardB');
    expect(result.outcome).toBe('resolved');
    const stream = transferStreamKey(topic, 'shardB');
    await until(async () => (await readEntries(rig.admin, stream)).length > 0, 2000);
    const entries = await readEntries(rig.admin, stream);
    expect(entries.length).toBe(1); // the helper only seeds state; this is the sole transfer on this topic
    expect(JSON.parse(entries[0]!['payload']!)).toEqual({ stateType: 'counters', stateData: '99' });
  });
});
