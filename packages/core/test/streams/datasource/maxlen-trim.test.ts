/**
 * `maxLen` opt-in trimming backstop (audit gap 13).
 *
 * `writeToStream` (streamable.ts) applies `MAXLEN ~ <maxLen>` to XADD only when
 * `options.maxLen > 0` (DataSourceOptions.maxLen — documented as an opt-in backstop).
 * `MAXLEN ~` is APPROXIMATE: Redis trims whole radix-tree macro nodes (default
 * ~100 entries/node) and only when the post-trim length stays >= maxLen. So the
 * envelope for maxLen=M after writing 3M entries is: XLEN >= M (never trims below the
 * floor) and XLEN < 3M (with M=100 and 300 writes, whole 100-entry nodes are
 * trimmable, so trimming provably fires). Exact XLEN is server-internal — assert the
 * envelope, not a point value.
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

const MAX_LEN = 100; // = the default macro-node size, so full nodes become trimmable
const TOTAL = MAX_LEN * 3;

let trimmed: StreamingDataSource;   // maxLen set
let untrimmed: StreamingDataSource; // no maxLen
const keyTrim = `itest:maxlen:on:${uniq()}`;
const keyRaw = `itest:maxlen:off:${uniq()}`;

beforeAll(async () => {
  trimmed = new StreamingDataSource({ ...REDIS, maxLen: MAX_LEN });
  untrimmed = new StreamingDataSource({ ...REDIS, controllable: false });
  await Promise.all([trimmed.connect(), untrimmed.connect()]);
});
afterAll(async () => {
  try { await untrimmed.client.send('DEL', [keyTrim, keyRaw]); } catch { /* teardown */ }
  try { await trimmed.disconnect(); } catch { /* teardown */ }
  try { await untrimmed.disconnect(); } catch { /* teardown */ }
});

const writeN = async (ds: StreamingDataSource, key: string, n: number) => {
  for (let i = 0; i < n; i++) {
    await ds.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: `m-${i}`,
      message: JSON.stringify({ i }), sourceId: 'maxlen-itest',
    });
  }
};
const xlen = async (key: string) => Number(await untrimmed.client.send('XLEN', [key]));

describe('writeToStream maxLen trimming (gap 13)', () => {
  test('with maxLen set, XLEN stays inside the approximate-trim envelope [maxLen, total)', async () => {
    await writeN(trimmed, keyTrim, TOTAL);
    const len = await xlen(keyTrim);
    expect(len).toBeGreaterThanOrEqual(MAX_LEN); // ~ never trims below the floor
    expect(len).toBeLessThan(TOTAL);             // trimming actually occurred
    // The newest maxLen entries are always retained: the last write must be present.
    const tail = await untrimmed.client.send('XREVRANGE', [keyTrim, '+', '-', 'COUNT', '1']) as Array<[string, string[]]>;
    expect(tail[0][1]).toContain(`m-${TOTAL - 1}`);
  }, 20000);

  test('without maxLen, writes never trim: XLEN equals the write count', async () => {
    await writeN(untrimmed, keyRaw, TOTAL);
    expect(await xlen(keyRaw)).toBe(TOTAL);
  }, 20000);
});
