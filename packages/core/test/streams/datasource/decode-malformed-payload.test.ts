/**
 * Decode resilience, second skip branch (TESTING_ANALYSIS core gaps 6 and 12):
 * an entry WITH a `messageId` but an undecodable JSON payload (or undecodable
 * `messageHeaders`) must be skipped with the reader surviving and the cursor
 * advancing (F3's other half — `decode-resilience.test.ts` covers only the
 * missing-messageId branch). Also pins the `messageHeaders` round-trip and the
 * non-json (`text`) protocol pass-through. Real Redis required
 * (`bun run start:redis`).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import type { Readable } from 'stream';
import { StreamingDataSource } from '../../../src';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let writer: StreamingDataSource;
beforeAll(async () => { writer = new StreamingDataSource({ ...REDIS, controllable: false }); await writer.connect(); });
afterAll(async () => { try { await writer.disconnect(); } catch { /* */ } });

const produce = (key: string, id: string) => writer.writeToStream({
  outgoingStream: key, incomingStream: undefined, messageType: 'data' as MessageType,
  messageId: id, message: JSON.stringify({ id }), sourceId: 's',
});

/** Raw XADD with full control of the wire fields. */
const rawEntry = (key: string, fields: Record<string, string>) =>
  writer.client.send('XADD', [key, '*', ...Object.entries(fields).flat()]);

async function until(fn: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (fn()) return true; await sleep(step); }
  return fn();
}

function tail(key: string) {
  const reader = new StreamingDataSource(REDIS);
  const got: MappedStreamEvent[] = [];
  let errored: Error | null = null;
  let ended = false;
  const start = async () => {
    await reader.connect();
    const stream: Readable = reader.getReadStream({ stream: key, last: '0', requestedBatchSize: 1, blockingTimeout: 50 });
    stream.on('data', (ev: MappedStreamEvent) => got.push(ev));
    stream.on('error', (e: Error) => { errored = e; });
    stream.on('end', () => { ended = true; });
  };
  const stop = async () => {
    try { reader.abort(); } catch { /* */ }
    await sleep(50);
    await reader.client.send('DEL', [key]).catch(() => {});
    await reader.disconnect();
  };
  return { got, start, stop, isErrored: () => errored, isEnded: () => ended };
}

test('an entry with a messageId but broken payload JSON is skipped; the reader survives and delivers the next valid entry', async () => {
  const key = `itest:decode-payload:${uniq()}`;
  const t = tail(key);
  await t.start();

  await produce(key, 'v-0');
  await until(() => t.got.some((e) => e.messageId === 'v-0') || !!t.isErrored(), 3000);

  // Streamerson-shaped entry, undecodable payload (json protocol, broken JSON).
  await rawEntry(key, {
    messageId: 'poison-1', messageType: 'data', incomingStream: '',
    messageHeaders: 'nil', messageProtocol: 'json', messageSourceId: 's',
    payload: '{broken',
  });
  await produce(key, 'v-1');

  await until(() => t.got.some((e) => e.messageId === 'v-1') || !!t.isErrored() || t.isEnded(), 4000);
  const endedNaturally = t.isEnded();
  await t.stop();

  expect({
    errored: t.isErrored() ? String(t.isErrored()!.message) : null,
    endedNaturally,
    delivered: t.got.map((e) => e.messageId),
  }).toEqual({ errored: null, endedNaturally: false, delivered: ['v-0', 'v-1'] });
}, 20000);

test('an entry with undecodable messageHeaders is skipped; valid headers round-trip; text protocol passes payload through raw', async () => {
  const key = `itest:decode-headers:${uniq()}`;
  const t = tail(key);
  await t.start();

  // Broken headers → skip.
  await rawEntry(key, {
    messageId: 'h-poison', messageType: 'data', incomingStream: '',
    messageHeaders: '{nope', messageProtocol: 'json', messageSourceId: 's',
    payload: '{"ok":true}',
  });
  // Valid headers → decoded onto the event.
  await rawEntry(key, {
    messageId: 'h-good', messageType: 'data', incomingStream: '',
    messageHeaders: '{"trace":"t-1"}', messageProtocol: 'json', messageSourceId: 's',
    payload: '{"ok":true}',
  });
  // Non-json protocol → payload passed through as the raw string, never JSON.parsed.
  await rawEntry(key, {
    messageId: 't-raw', messageType: 'data', incomingStream: '',
    messageHeaders: 'nil', messageProtocol: 'text', messageSourceId: 's',
    payload: 'not json at all',
  });

  await until(() => t.got.length >= 2 || !!t.isErrored() || t.isEnded(), 4000);
  await sleep(200); // stability window: the skipped entry must not surface late
  const endedNaturally = t.isEnded();
  await t.stop();

  expect(t.isErrored()).toBeNull();
  expect(endedNaturally).toBe(false);
  expect(t.got.map((e) => e.messageId)).toEqual(['h-good', 't-raw']);
  expect(t.got[0].messageHeaders).toEqual({ trace: 't-1' });
  expect(t.got[0].payload).toEqual({ ok: true });
  expect(t.got[1].payload).toBe('not json at all');
}, 20000);
