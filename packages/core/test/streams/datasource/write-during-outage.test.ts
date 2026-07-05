/**
 * `writeToStream` across a real connection drop (audit gap 9).
 *
 * Question pinned: what does a write issued IMMEDIATELY after the data connection is
 * killed (CLIENT KILL from an admin connection — the reconnect.test.ts technique; the
 * shared server is never stopped) actually do? The connection is NOT parked in a
 * blocking read (that posture hits the known Bun reply-desync documented in
 * reconnect.test.ts and is deliberately avoided here).
 *
 * OBSERVED (Bun 1.3.x RedisClient, idle connection killed): the client transparently
 * auto-reconnects and the queued XADD is flushed on the new connection — the write
 * PROMISE RESOLVES and the entry is DURABLE (probe: resolved in ~55-65ms with XLEN
 * confirming the entry, stable across 3 consecutive runs). This test pins that behavior as the
 * contract, with durability verified via XRANGE (a transparent retry is only
 * defensible if verified-durable). The hard floor either way: the write must SETTLE
 * within a 5s bound — an unbounded hang would be a RED-worthy defect (everything here
 * is raced so the suite can never hang).
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import type { MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_BOUND = 5000;

let admin: StreamingDataSource;
const key = `itest:writeoutage:${uniq()}`;

beforeAll(async () => {
  admin = new StreamingDataSource({ ...REDIS, controllable: false });
  await admin.connect();
});
afterAll(async () => {
  try { await admin.client.send('DEL', [key]); } catch { /* teardown */ }
  try { await admin.disconnect(); } catch { /* teardown */ }
});

// Kill by pre-captured CLIENT ID rather than scanning CLIENT LIST: under a full
// `bun test` run the server holds ~180 clients and Bun 1.3.x's RedisClient desyncs
// on the large CLIENT LIST reply (ERR_REDIS_INVALID_RESPONSE).
async function killId(id: string): Promise<number> {
  return Number(await admin.client.send('CLIENT', ['KILL', 'ID', id]));
}

describe('writeToStream on a dropped connection (gap 9)', () => {
  test('a write issued immediately after CLIENT KILL settles within bound; on success the entry is durable', async () => {
    const writer = new StreamingDataSource({ ...REDIS, controllable: false }); // single data connection
    await writer.connect();
    const writerId = String(await writer.client.send('CLIENT', ['ID']));

    // Prove liveness, then kill the (idle, NOT blocking-read-parked) data connection.
    await writer.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: 'pre-kill',
      message: JSON.stringify({}), sourceId: 'wdo-itest',
    });
    expect(await killId(writerId)).toBe(1);

    // Immediately write into the dead connection; bound the settle so nothing hangs.
    const SENTINEL = Symbol('timeout');
    const write = writer.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: 'during-outage',
      message: JSON.stringify({ n: 1 }), sourceId: 'wdo-itest',
    });
    const outcome = await Promise.race([
      write.then(() => 'resolved' as const, () => 'rejected' as const),
      sleep(SETTLE_BOUND).then(() => SENTINEL),
    ]);

    // Hard floor of the contract: BOUNDED settle. An unbounded hang here is the
    // RED-worthy defect this test guards against (silent stall = data loss with no
    // signal to the caller's retry policy).
    expect(outcome).not.toBe(SENTINEL);

    if (outcome === 'resolved') {
      // PINNED (observed): Bun's client auto-reconnects and flushes the write —
      // defensible only as a VERIFIED-durable transparent retry. Confirm via XRANGE
      // from an independent connection that the entry actually landed exactly once.
      const range = await admin.client.send('XRANGE', [key, '-', '+']) as Array<[string, string[]]>;
      const ids = range.map(([, kv]) => kv[kv.indexOf('messageId') + 1]);
      expect(ids.filter((id) => id === 'during-outage').length).toBe(1);
    } else {
      // A bounded reject is the other defensible behavior: the caller is told, and
      // writeToStream's wrapper names the failing key.
      await expect(write).rejects.toThrow('Failed XADD');
    }

    // Either way the datasource must be recoverable for subsequent writes.
    try { await writer.reconnect(); } catch { /* resolved path needs no reconnect */ }
    await writer.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: 'post-heal',
      message: JSON.stringify({}), sourceId: 'wdo-itest',
    });
    const finalIds = (await admin.client.send('XRANGE', [key, '-', '+']) as Array<[string, string[]]>)
      .map(([, kv]) => kv[kv.indexOf('messageId') + 1]);
    expect(finalIds).toContain('post-heal');

    await writer.disconnect();
  }, 20000);
});
