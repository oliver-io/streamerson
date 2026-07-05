/**
 * RedisDataSource reconnect / connection-drop behavior — integration tests against
 * REAL Redis with REAL connection drops (punch-list P1-8; core gaps 3, 5, 9).
 *
 * This is the real-world exercise of the seam the gateway self-heal suite (GW15)
 * mocks: `reconnect()` (fresh connections + re-run of subclass `connect()` setup,
 * i.e. SCRIPT LOAD), the `closing` latch, and `currentTopId` outage-cursor seeding.
 *
 * Connection drops are induced for-real from a separate admin connection via
 * `CLIENT KILL ID <id>`, targeting the datasource's connections by id captured
 * up-front with `CLIENT ID` on each victim connection. (We deliberately avoid
 * whole-list `CLIENT LIST` scans: under a full `bun test` run the server holds
 * ~180 clients and Bun 1.3.x's RedisClient desyncs on the large reply —
 * ERR_REDIS_INVALID_RESPONSE. `CLIENT LIST ID <id>` returns a single tiny line
 * and is safe.) The shared Redis server is never stopped or reconfigured.
 *
 * Run: bun test packages/core/test/streams/datasource/reconnect.test.ts
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { Readable } from 'stream';
import { StreamingDataSource } from '../../../src';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Admin datasource: issues CLIENT LIST / CLIENT KILL / DEL out-of-band. */
let admin: StreamingDataSource;

beforeAll(async () => {
  admin = new StreamingDataSource({ ...REDIS, controllable: false });
  await admin.connect();
});
afterAll(async () => {
  try { await admin.disconnect(); } catch { /* teardown */ }
});

/** Bounded event-driven wait: resolves true when `event` fires, false at deadline. */
function waitForEvent(emitter: NodeJS.EventEmitter, event: string, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { emitter.removeListener(event, onEvent); resolve(false); }, deadlineMs);
    const onEvent = () => { clearTimeout(timer); resolve(true); };
    emitter.once(event, onEvent);
  });
}

/** Bounded condition poll (for server-side state like CLIENT LIST, which has no event). */
async function pollUntil(cond: () => Promise<boolean>, deadlineMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/** The connection's own server-side id, captured via CLIENT ID on that connection. */
async function captureId(conn: { send(cmd: string, args: string[]): Promise<unknown> }): Promise<string> {
  return String(await conn.send('CLIENT', ['ID']));
}

/** CLIENT KILL each captured id; returns how many were killed. */
async function killIds(ids: string[]): Promise<number> {
  let killed = 0;
  for (const id of ids) {
    killed += Number(await admin.client.send('CLIENT', ['KILL', 'ID', id]));
  }
  return killed;
}

/** True when the connection with `id` is parked in a blocking command (flags=b).
 * Uses `CLIENT LIST ID <id>` — a single-entry (tiny) reply, avoiding the large-reply desync. */
async function isBlockedById(id: string): Promise<boolean> {
  const line = String(await admin.client.send('CLIENT', ['LIST', 'ID', id]));
  return /\bflags=\S*b/.test(line);
}

const writeOne = (ds: StreamingDataSource, stream: string, messageId: string, payload: unknown) =>
  ds.writeToStream({
    outgoingStream: stream, incomingStream: undefined,
    messageType: 'data' as MessageType, messageId,
    message: JSON.stringify(payload), sourceId: 'reconnect-itest',
  });

describe('RedisDataSource — real connection drops and reconnect()', () => {
  /**
   * INTENDED CONTRACT (per the stream-reader audit): a non-intentional connection
   * drop while the Readable's read loop is parked in a blocking XREAD must surface
   * as an `'error'` event on the Readable — not a silent stall, not a silent end.
   *
   * OBSERVED BEHAVIOR (Bun 1.3.x RedisClient, verified with a standalone probe):
   * after `CLIENT KILL` of a connection parked in `send('XREAD', ['BLOCK', ...])`,
   *   1. the in-flight command's promise NEVER settles (no rejection, no resolution
   *      — still pending >8s after the kill; `onclose` never fires),
   *   2. the client silently auto-reconnects (`connected` stays true), and
   *   3. the next reply on the new connection is mis-correlated to the wedged
   *      promise (a subsequent PING's 'PONG' resolved the parked XREAD promise,
   *      while the PING itself hung) — a reply/command desync.
   * Net effect at the datasource layer: the read loop hangs forever inside
   * `blockingStreamBatchMap` and the Readable emits nothing. This test therefore
   * pins the INTENDED contract and is expected RED until the drop is detected
   * (e.g. via onclose + rejecting/abandoning in-flight commands) — real product
   * misbehavior, not a test artifact.
   */
  test('RED (known defect): killing the data connection mid-blocking-read surfaces as a Readable error', async () => {
    const victim = new StreamingDataSource({ ...REDIS, controllable: false });
    await victim.connect();
    const victimId = await captureId(victim.client);

    const key = `itest:reconnect:drop:${uniq()}`;
    // Long BLOCK so the read is deterministically parked when the kill lands.
    const readable: Readable = victim.getReadStream({ stream: key, last: '$', blockingTimeout: 8000 });
    let errored = false;
    let ended = false;
    const sawError = waitForEvent(readable, 'error', 4000);
    readable.on('error', () => { errored = true; });
    readable.on('end', () => { ended = true; });
    readable.on('data', () => { /* none expected */ });

    // Wait (bounded) until the server reports the connection blocked, then kill it.
    expect(await pollUntil(() => isBlockedById(victimId), 3000)).toBe(true);
    expect(await killIds([victimId])).toBe(1);

    await sawError;
    expect(ended).toBe(false);       // must not silently end
    expect(errored).toBe(true);      // INTENDED: 'error' — currently silent hang (RED)

    // Teardown: cancel the loop and close; the wedged in-flight promise is
    // abandoned (known Bun client behavior above) — safe to leave dangling.
    readable.destroy();
    try { await victim.disconnect(); } catch { /* teardown */ }
  }, 20000);

  test('reconnect() after a real kill restores writes, reads, Lua paths, and clears closing', async () => {
    const ds = new StreamingDataSource(REDIS); // controllable: data + control connections
    await ds.connect();
    const dataId = await captureId(ds.client);
    const controlId = await captureId(ds.control);

    const key = `itest:reconnect:restore:${uniq()}`;
    // Prove liveness pre-drop.
    await writeOne(ds, key, 'pre-1', { n: 0 });
    expect(await ds.currentTopId(key)).not.toBe('0');

    // Park the data connection in a blocking read (the realistic outage posture),
    // then kill BOTH connections for real. The parked promise is abandoned — per
    // the probe evidence it never settles; do not await it.
    void ds.readAsSingle(key, '$', 8000).catch(() => { /* abandoned on kill */ });
    expect(await pollUntil(() => isBlockedById(dataId), 3000)).toBe(true);
    expect(await killIds([dataId, controlId])).toBe(2);

    // reconnect(): fresh connections, closing cleared, loadScripts re-run.
    await ds.reconnect();

    // (a) writes work.
    await writeOne(ds, key, 'post-1', { n: 1 });
    // (b) reads work — non-group blocking read drains the full history.
    const { events } = await ds.blockingStreamBatchMap({ stream: key, last: '0', blockingTimeout: 500, requestedBatchSize: 10 });
    expect(events.map((e) => e.messageId)).toEqual(['pre-1', 'post-1']);

    // (c) Lua script path post-reconnect: respondAndAck end-to-end.
    const group = 'g';
    await ds.createConsumerGroup({ stream: key, groupId: group, cursor: '0' });
    const delivered = await ds.readGroupEntries(key, group, 'm1', '>', 500);
    expect(delivered.length).toBe(2);
    const respKey = `${key}:resp`;
    await ds.respondAndAck({
      producerStream: respKey, consumerStream: key, groupId: group,
      streamMessageId: delivered[0].streamMessageId!, messageId: delivered[0].messageId,
      messageType: 'resp', messageSourceId: 's', payload: JSON.stringify({ ok: true }),
    });
    expect((await ds.pendingDetails(key, group)).length).toBe(1); // one acked, one still pending

    // SCRIPT FLUSH + reconnect: connect() must re-run loadScripts, so the cached
    // SHAs resolve again server-side (SCRIPT EXISTS → 1) and respondAndAck works.
    await admin.client.send('SCRIPT', ['FLUSH']);
    await ds.reconnect();
    const shas = (ds as unknown as { _scriptShas: { respondAndAck?: string } })._scriptShas;
    expect(shas.respondAndAck).toBeDefined();
    expect(await admin.client.send('SCRIPT', ['EXISTS', shas.respondAndAck!])).toEqual([1]);
    await ds.respondAndAck({
      producerStream: respKey, consumerStream: key, groupId: group,
      streamMessageId: delivered[1].streamMessageId!, messageId: delivered[1].messageId,
      messageType: 'resp', messageSourceId: 's', payload: JSON.stringify({ ok: true }),
    });
    expect((await ds.pendingDetails(key, group)).length).toBe(0);

    // (d) closing is cleared — behaviorally: after disconnect() (latch set) then
    // reconnect(), a blocking read returns REAL events, not the intentional-close
    // empty result that the latch produces.
    await ds.disconnect();
    await ds.reconnect();
    const post = await ds.blockingStreamBatchMap({ stream: key, last: '0', blockingTimeout: 500, requestedBatchSize: 10 });
    expect(post.events.length).toBe(2);
    expect(await ds.debugPing()).toBe('PONG');

    await admin.client.send('DEL', [key, respKey]);
    await ds.disconnect();
  }, 25000);

  test('currentTopId seeds a loss-free cursor across an outage: backlog arrives in order exactly once', async () => {
    const reader = new StreamingDataSource({ ...REDIS, controllable: false });
    const writer = new StreamingDataSource({ ...REDIS, controllable: false });
    await Promise.all([reader.connect(), writer.connect()]);
    const readerId = await captureId(reader.client);

    const key = `itest:reconnect:seed:${uniq()}`;
    await writeOne(writer, key, 'before-outage', { i: -1 });

    // Capture the "from now" cursor, then drop the reader for real.
    const cursor = await reader.currentTopId(key);
    expect(cursor).not.toBe('0');
    expect(await killIds([readerId])).toBe(1);

    // Outage window: the writer keeps producing while the reader is down.
    for (let i = 0; i < 5; i++) {
      await writeOne(writer, key, `outage-${i}`, { i });
    }

    // Heal and read strictly after the captured cursor.
    await reader.reconnect();
    const { events } = await reader.blockingStreamBatchMap({ stream: key, last: cursor, blockingTimeout: 500, requestedBatchSize: 10 });
    expect(events.map((e) => e.messageId)).toEqual(['outage-0', 'outage-1', 'outage-2', 'outage-3', 'outage-4']);

    await admin.client.send('DEL', [key]);
    await Promise.all([reader.disconnect(), writer.disconnect()]);
  }, 15000);

  test('currentTopId edge cases: missing/empty stream → "0"; with entries → the actual last id', async () => {
    const key = `itest:reconnect:topid:${uniq()}`;
    expect(await admin.currentTopId(key)).toBe('0');            // absent stream

    const id1 = String(await writeOne(admin, key, 'e1', { a: 1 }));
    expect(await admin.currentTopId(key)).toBe(id1);
    const id2 = String(await writeOne(admin, key, 'e2', { a: 2 }));
    expect(await admin.currentTopId(key)).toBe(id2);            // tracks the newest entry

    // Emptied-but-existing stream (XADD then XDEL leaves length 0): last-generated-id
    // is gone from XREVRANGE, so the loss-tolerant contract yields '0'.
    await admin.client.send('XDEL', [key, id1, id2]);
    expect(await admin.currentTopId(key)).toBe('0');

    // Not-yet-connected datasource: tolerant seeding yields '0', no throw.
    const cold = new StreamingDataSource(REDIS);
    expect(await cold.currentTopId(key)).toBe('0');

    await admin.client.send('DEL', [key]);
  }, 10000);
});
