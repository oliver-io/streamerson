/**
 * RED resilience test (TESTING_ANALYSIS gateway-wss gap 4; confirmed bug #6,
 * first half): a Redis write failure while sockets are open must not kill the
 * gateway process. Today neither of `streamRoute`'s streams has an `'error'`
 * listener, so a failed XADD emits an unhandled `'error'` on the Writable and
 * crashes the process.
 *
 * The gateway runs as a REAL subprocess (fixture) so process death is
 * observable as behavior, not simulated. The failure injection is real too:
 * the topic's consumer stream key is WRONGTYPE'd (SET to a plain string), so
 * the gateway's XADD genuinely fails at Redis. EXPECTED TO FAIL until the
 * gateway handles stream write errors. Requires Redis (`bun run start:redis`).
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource, Topic } from '@streamerson/core';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const PORT = 19700 + Math.floor(Math.random() * 200);
const topicName = `crash-${Date.now()}`;
const topic = new Topic({ namespace: 'wss-itest', topic: topicName });

let proc: ReturnType<typeof Bun.spawn> | undefined;
let redis: StreamingDataSource | undefined;

afterAll(async () => {
  try { proc?.kill(); } catch { /* ignore */ }
  if (redis) {
    try { await redis.client.send('DEL', [topic.consumerKey()]); } catch { /* ignore */ }
    try { await redis.disconnect(); } catch { /* ignore */ }
  }
});

test('gateway survives a Redis write failure with sockets open (no unhandled stream error)', async () => {
  redis = new StreamingDataSource(REDIS);
  await redis.connect();
  // Real failure injection: make XADD to the consumer stream fail with WRONGTYPE.
  await redis.set({ key: topic.consumerKey() }, 'not-a-stream');

  proc = Bun.spawn({
    cmd: [process.execPath, 'run', `${import.meta.dir}/fixtures/wss-server-fixture.ts`],
    env: { ...process.env, WSS_FIXTURE_PORT: String(PORT), WSS_FIXTURE_TOPIC: topicName },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Event-driven readiness: wait for the fixture's READY line.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Date.now() + 10000;
  while (!buffered.includes('READY')) {
    if (Date.now() > deadline) throw new Error(`fixture never became ready: ${buffered}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`fixture exited before READY: ${buffered}`);
    buffered += decoder.decode(value);
  }
  reader.releaseLock();

  // Open a real socket and send a frame; the gateway's XADD will fail at Redis.
  const ws = new WebSocket(`ws://localhost:${PORT}/echo`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(`ws connect failed: ${String(e)}`));
  });
  ws.send(JSON.stringify({ token: 'tok-crash', boom: true }));

  // The failed write must not take the process down: it should still answer HTTP.
  // Give the failure a moment to propagate, bounded by the exited promise.
  const exited = proc.exited.then((code) => ({ exited: true as const, code }));
  const stillUp = (async () => {
    await new Promise((r) => setTimeout(r, 750));
    const res = await fetch(`http://localhost:${PORT}/nope`);
    return { exited: false as const, status: res.status };
  })();

  const outcome = await Promise.race([exited, stillUp]);
  try { ws.close(); } catch { /* ignore */ }

  if (outcome.exited) {
    const stderr = await new Response(proc.stderr).text();
    expect().fail(`gateway process died on a Redis write failure (exit ${outcome.code}). stderr tail: ${stderr.slice(-500)}`);
  } else {
    expect(outcome.status).toBe(404); // routing still alive after the failed write
  }
}, 20000);
