/**
 * Member construction invariants (no Redis — pure construction, the data source
 * connects lazily so nothing here opens a socket).
 *
 * Contract pinned here:
 *  - one connection per member: a member replies via respondAndAck on its incoming
 *    control connection, so the base-created outgoing channel/stream are dropped —
 *    even when bidirectional — rather than carrying a dead field + a second idle
 *    connection (member.ts constructor);
 *  - clone() yields a fresh, independent member carrying the same consumer settings
 *    with its member settings overlaid.
 *
 * Run: bun test packages/consumer/test/member-construction.test.ts
 */
import { test, expect, describe } from 'bun:test';
import { ConsumerGroupMember } from '../src/member';
import { makeTopic, REDIS } from './harness';

describe('ConsumerGroupMember construction', () => {
  test('drops the inherited outgoing channel/stream (one connection per member), even when bidirectional', () => {
    const member = new ConsumerGroupMember(
      { topic: makeTopic('mc-bidi'), redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async () => ({}) } },
      { groupId: 'g', groupMemberId: 'cm-1' },
    );
    // The base ctor wires an outgoing channel for a bidirectional consumer; the member
    // nulls it (it responds atomically on the incoming connection via respondAndAck).
    expect(member.outgoingChannel).toBeUndefined();
    expect(member.outgoingStream).toBeUndefined();
    // It still keeps its single incoming control connection.
    expect(member.incomingChannel).toBeDefined();
    expect(member.bidirectional).toBe(true); // bidirectional terminal path, sans 2nd connection
  });

  test('clone() returns a fresh, independent member with member settings overlaid', () => {
    const opts = { topic: makeTopic('mc-clone'), redisConfiguration: REDIS, bidirectional: true, eventMap: { echo: async () => ({}) } };
    const original = new ConsumerGroupMember(opts, { groupId: 'g', groupMemberId: 'cm-1' });

    const sameId = original.clone();
    expect(sameId).toBeInstanceOf(ConsumerGroupMember);
    expect(sameId).not.toBe(original);                       // a new instance, not the same object
    expect(sameId.memberSettings).toEqual({ groupId: 'g', groupMemberId: 'cm-1' });

    const overridden = original.clone({ groupMemberId: 'cm-2' });
    expect(overridden.memberSettings).toEqual({ groupId: 'g', groupMemberId: 'cm-2' }); // overlay applied
    expect(original.memberSettings.groupMemberId).toBe('cm-1');                          // original untouched
    expect(overridden.incomingChannel).not.toBe(original.incomingChannel);               // independent connection
  });
});
