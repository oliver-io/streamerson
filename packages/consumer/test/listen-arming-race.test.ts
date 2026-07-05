/**
 * A9 regression guard — listen-arming race (BEHAVIOR_AUDIT.md Addendum A9).
 *
 * Contract: `connectAndListen()` resolving means the consumer IS listening — a
 * message written on the very next line must be processed. Before the fix, the
 * base consumer's reader was armed with `'$'`, which the read loop resolves only
 * at its FIRST XREAD (after connectAndListen returned), so a write landing in
 * that arm-up gap was skipped forever. Reproduced pre-fix at 17/30 iterations in
 * a tight loop (2026-07-05, bun 1.3.14). The fix pins the cursor to the stream's
 * captured tip (`currentTopId`) before connectAndListen resolves — the same
 * Q9/GW15 pattern as the gateway reader self-heal.
 *
 * Tight loop: connect → write immediately → expect the handler to fire. N high
 * enough that the pre-fix race (>50% per iteration) cannot slip through.
 * Requires Redis (`bun run start:redis`).
 */
import { test, expect } from 'bun:test';
import Pino from 'pino';
import { StreamingDataSource, Topic } from '@streamerson/core';
import type { MessageType } from '@streamerson/core';
import { StreamConsumer } from '../src/base/stream-consumer';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
};
const quiet = Pino({ level: 'silent' });
const ITERATIONS = 15;

test('a message written immediately after connectAndListen() resolves is always processed (A9)', async () => {
  const admin = new StreamingDataSource(REDIS);
  await admin.connect();
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const topic = new Topic({ namespace: 'itest', topic: `a9-arming-${Date.now()}-${i}` });
      let hit = false;
      const consumer = new StreamConsumer({
        topic,
        redisConfiguration: REDIS,
        logger: quiet as any,
        bidirectional: false,
        eventMap: { ping: async () => { hit = true; return { ok: 1 }; } },
      });
      await consumer.connectAndListen();
      await admin.writeToStream({
        outgoingStream: topic.consumerKey(),
        incomingStream: topic.producerKey(),
        messageType: 'ping' as MessageType,
        messageId: `a9-${i}`,
        message: JSON.stringify({ i }),
        sourceId: 'a9-test',
      });
      const deadline = Date.now() + 2000;
      while (!hit && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      try { await consumer.disconnect(); } catch { /* teardown only */ }
      expect(hit, `iteration ${i}: message written immediately after connectAndListen was never processed`).toBe(true);
    }
  } finally {
    await admin.disconnect();
  }
}, 60_000);
