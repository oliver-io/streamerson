/**
 * Regression tests (TESTING_ANALYSIS core gap 1; confirmed bug #4): two
 * concurrent read streams on ONE datasource instance must be isolated — each
 * Readable delivers only its own stream's entries. The two readers share the
 * instance's `streamIdMap`/`keyEvents`, so opening a second read stream while
 * the first is already consuming emits UPDATE and flips the running iterator
 * into multi-stream fan-in over the UNION of keys — cross-delivery.
 *
 * Test 1 (both readers armed before consuming) PASSES today: no UPDATE is
 * observed by a not-yet-started iterator, so both stay single-stream — pinned
 * as a working case. Test 2 (second reader opened while the first is live) is
 * the RED case and is EXPECTED TO FAIL with b* entries cross-delivered to
 * reader A until per-reader stream sets are isolated.
 * Requires Redis (`bun run start:redis`).
 */
import { test, expect, afterAll } from 'bun:test';
import { StreamingDataSource } from '../../../src/datasource/streamable';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEY_A = `itest::concurrent-readers-${stamp}::A`;
const KEY_B = `itest::concurrent-readers-${stamp}::B`;

const reader = new StreamingDataSource(REDIS);
const writer = new StreamingDataSource(REDIS);
const sources: StreamingDataSource[] = [reader, writer];

afterAll(async () => {
  for (const ds of sources) { try { ds.abort(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 150));
  try { await writer.client.send('DEL', [KEY_A]); } catch { /* ignore */ }
  try { await writer.client.send('DEL', [KEY_B]); } catch { /* ignore */ }
  for (const ds of sources) { try { await ds.disconnect(); } catch { /* ignore */ } }
});

test('two read streams on one datasource each deliver only their own stream\'s entries', async () => {
  await Promise.all([reader.connect(), writer.connect()]);

  const gotA: string[] = [];
  const gotB: string[] = [];
  const streamA = reader.getReadStream({ stream: KEY_A, last: '0' });
  const streamB = reader.getReadStream({ stream: KEY_B, last: '0' });
  streamA.on('data', (e: MappedStreamEvent) => gotA.push(e.messageId));
  streamB.on('data', (e: MappedStreamEvent) => gotB.push(e.messageId));

  const produce = (key: string, id: string) => writer.writeToStream({
    outgoingStream: key,
    incomingStream: undefined,
    messageType: 'test' as MessageType,
    messageId: id,
    message: JSON.stringify({ id }),
    sourceId: 's',
  });
  await produce(KEY_A, 'a1');
  await produce(KEY_B, 'b1');
  await produce(KEY_A, 'a2');
  await produce(KEY_B, 'b2');

  // Event-driven wait for full expected delivery, then a short stability window
  // so any late cross-delivery/duplication would still be observed.
  const deadline = Date.now() + 5000;
  while ((gotA.length < 2 || gotB.length < 2) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300));

  expect(gotA.sort()).toEqual(['a1', 'a2']); // no b* leakage, no duplicates
  expect(gotB.sort()).toEqual(['b1', 'b2']); // no a* leakage, no duplicates
}, 15000);

test('a read stream opened while another is live must not receive the other stream\'s entries', async () => {
  const KEY_C = `itest::concurrent-readers-${stamp}::C`;
  const KEY_D = `itest::concurrent-readers-${stamp}::D`;
  const lateReader = new StreamingDataSource(REDIS);
  const lateWriter = new StreamingDataSource(REDIS);
  sources.push(lateReader, lateWriter);
  await Promise.all([lateReader.connect(), lateWriter.connect()]);

  const produce = (key: string, id: string) => lateWriter.writeToStream({
    outgoingStream: key,
    incomingStream: undefined,
    messageType: 'test' as MessageType,
    messageId: id,
    message: JSON.stringify({ id }),
    sourceId: 's',
  });

  const gotC: string[] = [];
  const gotD: string[] = [];

  // Arm reader C and prove it is LIVE (delivers c1) before opening reader D.
  const streamC = lateReader.getReadStream({ stream: KEY_C, last: '0' });
  streamC.on('data', (e: MappedStreamEvent) => gotC.push(e.messageId));
  await produce(KEY_C, 'c1');
  const cLive = Date.now() + 5000;
  while (gotC.length < 1 && Date.now() < cLive) await new Promise((r) => setTimeout(r, 25));
  expect(gotC).toEqual(['c1']);

  // Open the second read stream on the SAME datasource while C is consuming.
  const streamD = lateReader.getReadStream({ stream: KEY_D, last: '0' });
  streamD.on('data', (e: MappedStreamEvent) => gotD.push(e.messageId));

  await produce(KEY_D, 'd1');
  await produce(KEY_C, 'c2');
  await produce(KEY_D, 'd2');

  const deadline = Date.now() + 5000;
  while ((gotC.length < 2 || gotD.length < 2) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300)); // stability window for late leakage

  try { lateReader.abort(); } catch { /* ignore */ }
  try { await lateWriter.client.send('DEL', [KEY_C]); } catch { /* ignore */ }
  try { await lateWriter.client.send('DEL', [KEY_D]); } catch { /* ignore */ }

  expect(gotC.sort()).toEqual(['c1', 'c2']); // intended: no d* cross-delivery to C
  expect(gotD.sort()).toEqual(['d1', 'd2']); // intended: no c* cross-delivery, no duplicates
}, 20000);
