/**
 * Delete-semantics suite (TEST_PLAN.md §4 "3.3"; BEHAVIOR_AUDIT.md 3.3; resolved
 * decision D-Delete: `set(K, null)` IS the scalar delete, algebra-symmetric with the
 * write algebra — owner: local delete + fire-and-forget `DEL`; renter: awaited `DEL`
 * + local eviction; `setHash(K, field, null)` is an HDEL and the local merge drops
 * the field).
 *
 * FIXED (BEHAVIOR_AUDIT.md 3.3, decision D-Delete): the spec tests below are the
 * regression guards; the documentary pins (I-D1/I-D2 pins, HDEL "nulls ship as the
 * string \"null\"" pin) were retired with the fix. Implemented contract:
 *  - owner `set(K, null)` / `del`: local delete + fire-and-forget DEL, returns true;
 *  - renter: awaited DEL + local eviction, returns the Redis reply (deleted > 0);
 *  - `setHash(K, field, null)`: null fields split into an HDEL arg list on the wire
 *    (non-nulls into the hSet delta) and the local merge DROPS the field.
 *
 * I-D3 (a tracking replica stops serving a deleted value) is OUT OF SCOPE here: it
 * needs the invalidation suite's client-tracking infrastructure and is deferred to
 * that suite per TEST_PLAN §4 sequencing.
 *
 * Live Redis required. Run: bun test packages/state-machine/test/delete-spec.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StateObjectTypes } from '@streamerson/core/src/types';
import type { StateConfiguration } from '../src/types';
import {
  assertGateOrSkip, testRig, makeDatasource, awaitReplicated, until,
} from './harness';

const rig = testRig();
beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

const ownerConf: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: true, replicated: true };
const renterConf: StateConfiguration = { type: StateObjectTypes.StandaloneString, owner: false, rent: true };
const ownerHashConf: StateConfiguration = { type: StateObjectTypes.StandaloneHash, owner: true, replicated: true };

const gated = describe.skipIf(!assertGateOrSkip());

gated('3.3 delete semantics (D-Delete)', () => {
  it('I-D1 spec: owner set(K, null) deletes — local get(K) is null and K becomes absent in Redis', async () => {
    const ds = await makeDatasource(rig, { name: 'del-id1-spec' });
    const K = rig.keyspace('del-id1-spec').key('k');
    await ds.set({ key: K }, 'v', ownerConf);
    await awaitReplicated(rig.observer, K, 'v');

    await ds.set({ key: K }, null, ownerConf);

    // Local view first: the owner's own read must not resurrect the deleted value.
    expect(await ds.get({ key: K }, ownerConf)).toBeNull(); // RED: serves cached 'v'
    // Owner delete is local + fire-and-forget DEL, so poll ground truth to absence.
    const gone = await until(async () => !(await rig.observer.exists(K)), 2000);
    expect(gone).toBe(true);
  });

  it('I-D2 spec: renter set(K, null) performs an awaited remote DEL and the next get does not serve the stale value', async () => {
    const ds = await makeDatasource(rig, { name: 'del-id2-spec' });
    const K = rig.keyspace('del-id2-spec').key('k');
    // Renter writes are awaited-durable; a first read populates the renter's local cache.
    await ds.set({ key: K }, 'v', renterConf);
    expect(await rig.observer.get(K)).toBe('v');
    expect(await ds.get({ key: K }, renterConf)).toBe('v');

    await ds.set({ key: K }, null, renterConf);

    // Renter delete is AWAITED: absence must hold the moment the promise resolves.
    expect(await rig.observer.exists(K)).toBe(false);
    // And the renter's own next read must not serve the stale cached 'v'.
    expect(await ds.get({ key: K }, renterConf)).toBeNull();
  });

  it('HDEL spec: owner setHash(K, field, null) drops the field locally and remotely (HDEL + local merge drops it)', async () => {
    const ds = await makeDatasource(rig, { name: 'del-hdel-spec' });
    const K = rig.keyspace('del-hdel-spec').key('h');
    await ds.setHash({ key: K }, 'f', 'val' as any, ownerHashConf);
    await until(async () => (await rig.observer.hgetall(K))['f'] === 'val', 2000);
    expect((await rig.observer.hgetall(K))['f']).toBe('val');

    await ds.setHash({ key: K }, 'f', null, ownerHashConf);

    // Locally the merge must DROP the field, not store null.
    const local = await ds.getHash({ key: K }, ownerHashConf);
    expect(local?.['f' as keyof typeof local]).toBeUndefined();
    // Remotely the field must be HDEL'd (owner-side fire-and-forget → poll).
    const fieldGone = await until(async () => !('f' in (await rig.observer.hgetall(K))), 2000);
    expect(fieldGone).toBe(true);
  });
});
