/**
 * Gap 9 (TESTING_ANALYSIS consumer gaps) — documented-acceptable over-report:
 * FAILED may over-report when the reaper steals from a slow-but-ALIVE member.
 *
 * With no retry, the coordinator's reaper (src/group.ts sweep) XAUTOCLAIMs any PEL
 * entry idle >= processingTimeout and dead-letters it as 'abandoned' — it cannot
 * distinguish a crashed member from one whose handler is merely slower than the
 * grace. The member, still alive, finishes the handler and calls respondAndAck,
 * whose Lua (core streamable.ts) is an unconditional {XADD response; XACK} — the
 * XACK is a no-op on the already-stolen entry but the response is still written.
 *
 * Pinned outcome (accepted contract, not a bug): a DLQ 'abandoned' entry AND a
 * response for the SAME messageId coexist; the PEL is empty; and the member's
 * read loop survives the steal (a subsequent message is handled normally).
 *
 * Live Redis required. Run: bun test packages/consumer/test/reaper-steal-slow-member.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupCoordinator } from '../src/group';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, pendingCount, readDlq, write, awaitResponse, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;
const topic = rig.topic('reap-slow');
const GROUP = 'reap-slow-group';
const GRACE = 300;        // reaper grace (processingTimeout)
const HANDLER_MS = 1200;  // deliberately > grace: slow-but-alive

let coordinator: ConsumerGroupCoordinator | undefined;
rig.onTeardown(() => coordinator?.disconnect());

beforeAll(async () => {
  await rig.connect();
  coordinator = new ConsumerGroupCoordinator(
    { topic, redisConfiguration: REDIS },
    { name: GROUP, count: 1, processingTimeout: GRACE }, // no retry -> reaper active
  );
  await coordinator.connectAndListen();
  await coordinator.create();
});

afterAll(() => rig.teardown());

test('reaper steals a slow-but-alive member\'s in-flight entry: DLQ abandoned + late response coexist; member stays live', async () => {
  // BARE member (no retry): its slow handler outruns the reaper grace.
  const member = rig.track(new ConsumerGroupMember(
    {
      topic, redisConfiguration: REDIS, bidirectional: true,
      eventMap: {
        slow: async (e: any) => { await sleep(HANDLER_MS); return { ok: true, late: true }; },
        quick: async () => ({ ok: true }),
      },
    },
    { groupId: GROUP, groupMemberId: 'slowpoke' },
  ));
  await member.connectAndListen();

  await write(admin, topic, 'slow', 'steal-1', { v: 1 });

  // The reaper terminalizes the in-flight entry as abandoned once idle >= grace,
  // while the handler is still running.
  await until(async () => (await readDlq(admin, topic)).length === 1, 4000);
  const dlq = await readDlq(admin, topic);
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.messageId).toBe('steal-1');
  expect(dlq[0]?.reason).toBe('abandoned');

  // The member still completes: its respondAndAck writes the response even though
  // the XACK half is now a no-op — over-report pinned: BOTH records exist.
  const got = await awaitResponse(topic, 'steal-1', HANDLER_MS + 3000);
  expect(got).toBeDefined();
  expect((got!.payload as any).late).toBe(true);
  expect((await readDlq(admin, topic))).toHaveLength(1); // DLQ record still there

  // Terminalized out of the PEL (by the reaper's deadLetterAndAck).
  await until(async () => (await pendingCount(admin, topic, GROUP)) === 0, 3000);
  expect(await pendingCount(admin, topic, GROUP)).toBe(0);

  // The member's loop survived the steal: a subsequent message is handled.
  await write(admin, topic, 'quick', 'after-steal', { v: 2 });
  const after = await awaitResponse(topic, 'after-steal', 4000);
  expect(after).toBeDefined();
  expect((after!.payload as any).ok).toBe(true);
}, 30000);
