/**
 * Decode resilience — a foreign/malformed entry must not kill the reader.
 *
 * Covers STREAM_READER_DEFECTS.md F3: `parseStreamReply` must skip + log an
 * undecodable entry (one with no `messageId`, e.g. a raw XADD from another tool)
 * instead of throwing, so the reader keeps delivering; and the cursor must advance
 * past the skipped entry so a trailing bad entry can't wedge the loop.
 *
 * Per docs/specs/TESTING.md #10 this is written first and is RED until the fix
 * (today the throw propagates to the Readable's 'error' event and ends the stream).
 * Real Redis required (`bun run start:redis`).
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

async function until(fn: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (fn()) return true; await sleep(step); }
  return fn();
}

test('a foreign/malformed entry is skipped; the reader survives and delivers valid entries before and after it', async () => {
  const key = `itest:decode:${uniq()}`;
  const reader = new StreamingDataSource(REDIS);
  await reader.connect();
  const got: string[] = [];
  let errored: Error | null = null;
  let ended = false;

  await produce(key, 'v-0');
  await produce(key, 'v-1');

  const stream: Readable = reader.getReadStream({ stream: key, last: '0', requestedBatchSize: 1, blockingTimeout: 50 });
  stream.on('data', (ev: MappedStreamEvent) => got.push(ev.messageId));
  stream.on('error', (e: Error) => { errored = e; });
  stream.on('end', () => { ended = true; });

  // Let the two valid entries be consumed (cursor advances past them) before the poison.
  await until(() => (got.includes('v-0') && got.includes('v-1')) || !!errored, 3000);

  // A foreign entry with no `messageId` field (e.g. a raw XADD from another tool),
  // then a valid entry after it — a resilient reader delivers the latter.
  await reader.client.send('XADD', [key, '*', 'foo', 'bar', 'baz', 'qux']);
  await produce(key, 'v-2');

  await until(() => got.includes('v-2') || !!errored || ended, 4000);

  // Capture whether the reader ended on its own (the defect) BEFORE we abort it.
  const endedNaturally = ended;
  try { reader.abort(); } catch { /* */ }
  await sleep(50);

  expect({
    errored: errored ? String((errored as Error).message) : null,
    endedNaturally,
    valid: got.filter((id) => id.startsWith('v-')).sort(),
  }).toEqual({ errored: null, endedNaturally: false, valid: ['v-0', 'v-1', 'v-2'] });

  await reader.client.send('DEL', [key]).catch(() => {});
  await reader.disconnect();
}, 20000);
