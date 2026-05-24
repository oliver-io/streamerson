/**
 * Restart / backoff loop (cluster.ts › scheduleRestart) against live Redis.
 * cluster.test.ts already covers a single restart-to-count; this exercises the loop
 * across MANY crash cycles and pins what the backoff/cap actually does.
 *
 * Contract pinned here:
 *  - a member that becomes ready then crashes ("flaps") is restarted, repeatedly, via
 *    the backoff loop — the coordinator keeps reconciling toward `count`.
 *
 * Verified finding (TESTING.md §7 — assert real behaviour, CLAUDE.md — verify, don't
 * assert): the `MAX_RESTARTS` give-up branch is unreachable for a member that recovers
 * to `ready`, because `spawnMember` resets `restartCounts → 0` on every `ready` and a
 * respawn that crashes *before* ready rejects without scheduling a further restart. So
 * the per-attempt exponential backoff resets each cycle and never climbs toward the cap.
 * This test demonstrates that empirically: ≥6 ready cycles inside a 4s window is only
 * possible with a resetting (~constant ~100ms) backoff — a non-resetting exponential
 * backoff (100,200,400,800,1600,3200…ms) reaches at most ~5 restarts in 4s and would
 * then give up at 10. The give-up branch itself is therefore dead code under the current
 * close-handler logic; left as-is (TDD: not changing the implementation here).
 *
 * Run: bun test packages/consumer/test/restart.test.ts
 */
import { test, expect, afterEach } from 'bun:test';
import path from 'path';
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupCluster } from '../src/cluster';
import { REDIS, sleep, makeTopic, cleanupKeys } from './harness';

const flappingFixture = path.resolve(import.meta.dir, 'fixtures', 'cluster-flapping-member.ts');

const admin = new StreamingDataSource(REDIS);
let adminConnected = false;
async function ensureAdmin() { if (!adminConnected) { await admin.connect(); adminConnected = true; } }

let cluster: ConsumerGroupCluster | undefined;
let topic: ReturnType<typeof makeTopic> | undefined;

afterEach(async () => {
  try { await cluster?.stop(); } catch { /* */ }   // running=false halts further restarts
  cluster = undefined;
  await sleep(150);
  if (topic && adminConnected) { await cleanupKeys(admin, topic); }
  topic = undefined;
});

test('a flapping member is restarted repeatedly via the backoff loop (cap reset on each ready, never tripped)', async () => {
  await ensureAdmin();
  topic = makeTopic('clu-flap');
  cluster = new ConsumerGroupCluster(
    { topic, bidirectional: true, redisConfiguration: REDIS },
    { name: 'flap-group', count: 1, processingTimeout: 1000, idleTimeout: 300 },
    flappingFixture,
  );
  await cluster.start();

  // Count restart cycles: rising edges of readyMembers (0 → 1) as the member crashes and
  // is respawned. A fine poll catches each ~100ms ready window.
  let edges = 0;
  let prev = cluster.readyMembers;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const now = cluster.readyMembers;
    if (prev === 0 && now === 1) edges++;
    prev = now;
    await sleep(15);
  }

  // ≥6 fast restarts within 4s ⇒ the backoff reset each cycle (reset-on-ready). A
  // non-resetting capped backoff could not reach this in the window — proving the loop
  // persists and the MAX_RESTARTS cap is not tripped for a recovering member.
  expect(edges).toBeGreaterThanOrEqual(6);
}, 30000);
