/**
 * Base `StreamConsumer` behaviours that aren't on the group-member path, against live
 * Redis (`bun run start:redis`):
 *  - `produceMessage`: a direct write onto the producer (response) stream, correlated
 *    by messageId;
 *  - `deregisterStreamEvent`: surgically removes one handler — a message of that type is
 *    then classified no-handler (dead-lettered), while a retained handler still answers;
 *  - base `connectAndListen` pipe + CG-G2: a throwing handler must NOT wedge the single-
 *    consumer pipeline (the Transform's catch always calls `callback()`), so the loop
 *    keeps consuming. The base single-consumer tails new messages with XREAD (the '$'
 *    boundary can skip until the first read advances the cursor), so this is asserted
 *    event-driven over a steady stream — a wedge would stop all progress after the first
 *    throw, regardless of which messages are caught.
 *
 * Run: bun test packages/consumer/test/base-consumer-integration.test.ts
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { StreamConsumer } from '../src/base/stream-consumer';
import { ConsumerGroupMember } from '../src/member';
import { REDIS, sleep, until, readDlq, write, awaitResponse, collectResponses, testRig } from './harness';

const rig = testRig();
const admin = rig.admin;

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

describe('StreamConsumer.produceMessage', () => {
  test('writes a correlated message onto the producer (response) stream', async () => {
    const topic = rig.topic('pm');
    const consumer = rig.track(new StreamConsumer({ topic, redisConfiguration: REDIS, bidirectional: true }));
    await consumer.connectAndListen();

    await consumer.produceMessage({ messageId: 'pm-1', messageType: 'resp', message: { ok: true, n: 7 }, sourceId: 'src' });

    const got = await awaitResponse(topic, 'pm-1', 4000);
    expect(got).toBeDefined();
    expect(got!.messageId).toBe('pm-1');
    expect(got!.payload).toEqual({ ok: true, n: 7 });
  }, 20000);
});

describe('StreamConsumer.deregisterStreamEvent', () => {
  test('removes one handler (→ no-handler dead-letter) while a retained handler still answers', async () => {
    const topic = rig.topic('dereg');
    const GROUP = 'dereg-group';
    await admin.createConsumerGroup({ stream: topic.consumerKey(), groupId: GROUP, cursor: '$' });

    const member = new ConsumerGroupMember(
      { topic, redisConfiguration: REDIS, bidirectional: true, eventMap: {
        echo: async () => ({ ok: true }),
        keep: async (e: any) => ({ kept: e.payload?.n }),
      } },
      { groupId: GROUP, groupMemberId: 'dr-1' },
    );
    rig.track(member);
    member.deregisterStreamEvent('echo'); // surgically drop only `echo`
    await member.connectAndListen();

    await write(admin, topic, 'echo', 'd-echo', { hi: 1 }); // now unhandled → no-handler DLQ
    await write(admin, topic, 'keep', 'd-keep', { n: 9 });  // still handled → answered

    const kept = await awaitResponse(topic, 'd-keep', 4000);
    expect(kept).toBeDefined();
    expect(kept!.payload).toEqual({ kept: 9 });             // retained handler unaffected

    await until(async () => (await readDlq(admin, topic)).some((e) => e.messageId === 'd-echo'), 4000);
    const dlq = await readDlq(admin, topic);
    expect(dlq.find((e) => e.messageId === 'd-echo')?.reason).toBe('no-handler');
    expect(dlq.some((e) => e.messageId === 'd-keep')).toBe(false); // the kept one was never dead-lettered
  }, 20000);
});

describe('StreamConsumer.connectAndListen (base single-consumer pipe)', () => {
  test('a throwing handler does not wedge the pipe — the loop keeps consuming (CG-G2)', async () => {
    const topic = rig.topic('basepipe');
    let boomsSeen = 0;
    const consumer = new StreamConsumer({
      topic, redisConfiguration: REDIS, bidirectional: true,
      eventMap: {
        echo: async (e: any) => ({ echoed: e.payload?.n }),
        boom: async () => { boomsSeen++; throw new Error('handler boom'); },
      },
    });
    rig.track(consumer);
    await consumer.connectAndListen();
    await sleep(250); // readiness: let the first blocking XREAD('$') arm before producing

    // Interleave echo/boom over a window. A wedged pipe (callback not called on throw)
    // would stop all progress after the FIRST boom it consumes.
    let stop = false;
    const producer = (async () => {
      for (let i = 0; !stop; i++) {
        await write(admin, topic, 'echo', `e-${i}`, { n: i });
        await write(admin, topic, 'boom', `x-${i}`, { n: i });
        await sleep(60);
      }
    })();

    const seen = await collectResponses(topic, 6, 3000); // distinct echo responses off the producer key
    stop = true; await producer;

    // The pipe processed multiple booms (advanced past each throw) AND kept answering
    // echoes — both impossible if the first throw had wedged the pipeline.
    expect(boomsSeen).toBeGreaterThanOrEqual(2);
    expect(seen.size).toBeGreaterThanOrEqual(2);
  }, 30000);
});
