/**
 * Shutdown semantics (TESTING_ANALYSIS gateway-wss gap 7): `stop()` must
 * actually tear the gateway down — close open sockets, end the response read
 * loop, disconnect the per-route datasource — so the process can exit. Today
 * `stop()` only calls `server.stop()`: sockets are left open and the blocking
 * XREAD + datasource keep the event loop alive forever.
 *
 * Runs the gateway as a REAL subprocess and asserts the intended contract:
 * after stop(), (a) an open client socket observes close, (b) the process
 * exits on its own within a bound. EXPECTED RED until stop() is a real
 * teardown. Requires Redis (`bun run start:redis`).
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource, Topic } from '@streamerson/core';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const PORT = 20400 + Math.floor(Math.random() * 200);
const topicName = `shutdown-${Date.now()}`;
const topic = new Topic({ namespace: 'wss-itest', topic: topicName });

let proc: ReturnType<typeof Bun.spawn> | undefined;

afterAll(async () => {
  try { proc?.kill(); } catch { /* ignore */ }
  const redis = new StreamingDataSource(REDIS);
  await redis.connect();
  try { await redis.client.send('DEL', [topic.consumerKey()]); } catch { /* ignore */ }
  try { await redis.client.send('DEL', [topic.producerKey()]); } catch { /* ignore */ }
  try { await redis.disconnect(); } catch { /* ignore */ }
});

test('stop() closes open sockets and lets the process exit', async () => {
  proc = Bun.spawn({
    cmd: [process.execPath, 'run', `${import.meta.dir}/fixtures/wss-stop-fixture.ts`],
    env: { ...process.env, WSS_FIXTURE_PORT: String(PORT), WSS_FIXTURE_TOPIC: topicName },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const readUntil = async (marker: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!buffered.includes(marker)) {
      if (Date.now() > deadline) throw new Error(`never saw ${marker}: ${buffered}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`fixture exited waiting for ${marker}: ${buffered}`);
      buffered += decoder.decode(value);
    }
  };
  await readUntil('READY', 10000);

  // A live socket that has actually exercised the route (subscribes its token).
  const ws = new WebSocket(`ws://localhost:${PORT}/echo`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(String(e)));
  });
  const socketClosed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    ws.onclose = () => { clearTimeout(timer); resolve(true); };
  });
  ws.send(JSON.stringify({ token: 'tok-shutdown', hello: true }));

  proc.stdin.write('stop\n');
  await proc.stdin.end();
  await readUntil('STOPPED', 10000);
  reader.releaseLock();

  // (a) The open socket must observe the shutdown.
  expect(await socketClosed).toBe(true);

  // (b) With sockets closed, the read loop ended, and the datasource
  // disconnected, nothing holds the event loop: the process exits on its own.
  const exit = await Promise.race([
    proc.exited,
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), 8000)),
  ]);
  expect(exit).toBe(0);
}, 40000);
