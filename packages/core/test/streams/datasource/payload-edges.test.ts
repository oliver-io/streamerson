/**
 * Payload edge cases through the real write → XADD → read → decode path:
 *   (a) JSON-hostile content (quotes, newlines, emoji, backslashes, and keys that
 *       collide with wire-field names) round-trips deep-equal;
 *   (b) a ~1MB payload string round-trips intact.
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

let writer: StreamingDataSource;
let reader: StreamingDataSource;
const keys: string[] = [];

beforeAll(async () => {
  writer = new StreamingDataSource({ ...REDIS, controllable: false });
  reader = new StreamingDataSource(REDIS);
  await Promise.all([writer.connect(), reader.connect()]);
});
afterAll(async () => {
  try { await reader.abort(); } catch { /* teardown */ }
  await sleep(150);
  try { if (keys.length) await writer.client.send('DEL', keys); } catch { /* teardown */ }
  try { await reader.disconnect(); } catch { /* teardown */ }
  try { await writer.disconnect(); } catch { /* teardown */ }
});

async function roundTrip(k: string, payload: unknown): Promise<MappedStreamEvent> {
  await writer.writeToStream({
    outgoingStream: k, incomingStream: undefined,
    messageType: 'data' as MessageType, messageId: 'rt-1',
    message: JSON.stringify(payload), sourceId: 'payload-edges',
  });
  const rs = reader.getReadStream({ stream: k, last: '0', blockingTimeout: 100 });
  let got: MappedStreamEvent | undefined;
  for await (const ev of rs as AsyncIterable<MappedStreamEvent>) { got = ev; break; }
  return got!;
}

describe('payload edges', () => {
  test('(a) JSON-hostile payload round-trips deep-equal (quotes, newlines, emoji, backslashes, wire-name keys)', async () => {
    const k = `itest:payload:hostile:${uniq()}`;
    keys.push(k);
    const payload = {
      quotes: `she said "hi" and 'bye'`,
      newlines: 'line1\nline2\r\nline3',
      emoji: 'streams 🌊🚀 — ok ✅',
      backslashes: 'C:\\Users\\olive\\code\\streamerson \\\\server\\share',
      // Keys colliding with the wire-protocol field names must not shadow or be
      // shadowed by the envelope — they live inside the JSON payload string.
      payload: { nested: 'inner-payload' },
      messageId: 'not-the-real-message-id',
      mixed: '{"looks":"like json"}\t"\\u2028"',
    };
    const got = await roundTrip(k, payload);
    expect(got.messageId).toBe('rt-1'); // envelope id, not the payload's decoy key
    expect(got.payload).toEqual(payload);
  }, 10000);

  test('(b) ~1MB payload string round-trips intact', async () => {
    const k = `itest:payload:large:${uniq()}`;
    keys.push(k);
    const unit = '0123456789abcdef'; // 16 chars
    const big = unit.repeat(65536) + 'TAIL-MARKER'; // 1_048_576 + 11 chars
    const got = await roundTrip(k, { blob: big, n: 1 });
    const blob = (got.payload as { blob: string }).blob;
    expect(blob.length).toBe(big.length);
    expect(blob.slice(0, 16)).toBe(unit);
    expect(blob.slice(-11)).toBe('TAIL-MARKER');
    expect((got.payload as { n: number }).n).toBe(1);
  }, 15000);
});
