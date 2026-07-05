/**
 * Dynamic fan-in of a NOT-YET-EXISTING stream (F1 seeding, absent-key arm).
 *
 * Contract (streamable.ts `lastGeneratedId`): XREVRANGE on a missing key returns
 * empty, so an absent stream added at runtime seeds its cursor at '0' — meaning
 * NOTHING written to it after the add can be lost to a seeding race: the first
 * entries ever written are delivered.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 100;

let writer: StreamingDataSource;
let reader: StreamingDataSource;
const keyA = `itest:absent:A:${uniq()}`;
const keyC = `itest:absent:C:${uniq()}`; // never written before addStreamId

beforeAll(async () => {
  writer = new StreamingDataSource({ ...REDIS, controllable: false });
  reader = new StreamingDataSource(REDIS);
  await Promise.all([writer.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { await writer.client.send('DEL', [keyA, keyC]); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await writer.disconnect(); } catch { /* teardown */ }
});

const writeOne = (key: string, messageId: string) => writer.writeToStream({
  outgoingStream: key, incomingStream: undefined,
  messageType: 'data' as MessageType, messageId,
  message: JSON.stringify({}), sourceId: 'absent',
});

async function until(cond: () => boolean, ms: number, step = 15) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (cond()) return true; await sleep(step); }
  return cond();
}

describe('addStreamId of a not-yet-existing stream (absent-key seeding)', () => {
  test("an absent stream seeds at '0': entries written after the add are all delivered", async () => {
    const received: Array<{ stream?: string; id: string }> = [];
    const stream = reader.getReadStream({ stream: keyA, last: '0', blockingTimeout: BLOCK });
    stream.on('data', (ev: MappedStreamEvent) => received.push({ stream: ev.streamId, id: ev.messageId }));

    // Reader demonstrably live on A before the add.
    await writeOne(keyA, 'a-0');
    expect(await until(() => received.some((r) => r.id === 'a-0'), 5000)).toBe(true);

    reader.addStreamId(keyC); // C does not exist — no XADD has ever touched it
    // Let the add fold in at a loop top and the '0' seed be taken (a few cycles).
    await sleep(3 * BLOCK);

    await writeOne(keyC, 'c-0');
    await writeOne(keyC, 'c-1');

    expect(await until(
      () => received.some((r) => r.id === 'c-0') && received.some((r) => r.id === 'c-1'),
      5000,
    )).toBe(true);
    stream.destroy();

    const fromC = received.filter((r) => r.stream === keyC).map((r) => r.id);
    expect(fromC).toEqual(['c-0', 'c-1']); // both delivered, in order — nothing raced away
  }, 15000);
});
