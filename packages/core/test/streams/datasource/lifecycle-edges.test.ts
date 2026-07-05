/**
 * Connection-lifecycle edge cases for the datasource (real Redis):
 *   (a) `client` before connect throws; connect() to a dead port rejects (bounded);
 *   (b) double connect() leaves the source functional;
 *   (c) abort() is idempotent and safe pre-connect;
 *   (d) control-vs-data separation: acks/terminal transitions run on the control
 *       connection and do not queue behind a parked blocking read;
 *   (e) a write after disconnect() settles with an error — never hangs.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import { Topic } from '../../../src/utils/topic';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keys: string[] = [];
const finalizers: Array<() => Promise<unknown> | unknown> = [];

afterAll(async () => {
  await sleep(150);
  if (keys.length) {
    const janitor = new StreamingDataSource({ ...REDIS, controllable: false });
    try { await janitor.connect(); await janitor.client.send('DEL', keys); } catch { /* teardown */ }
    try { await janitor.disconnect(); } catch { /* teardown */ }
  }
  for (const f of finalizers) { try { await f(); } catch { /* teardown */ } }
});

const writeOne = (ds: StreamingDataSource, k: string, messageId: string) => ds.writeToStream({
  outgoingStream: k, incomingStream: undefined,
  messageType: 'data' as MessageType, messageId,
  message: JSON.stringify({}), sourceId: 'lifecycle',
});

function capped<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`CAP: ${label} did not settle within ${ms}ms`)), ms)),
  ]);
}

describe('datasource lifecycle edges', () => {
  test('(a) client getter before connect throws; connect() to a dead port rejects within bound', async () => {
    const fresh = new StreamingDataSource(REDIS);
    expect(() => fresh.client).toThrow(/before initialization/);

    // Dead port: nothing listens on 63999. Pinned by a standalone reduction:
    // Bun's RedisClient retries with backoff and rejects only after ~31s
    // (RedisError: "Connection closed") under its DEFAULT policy — i.e. a bare
    // connect() to a dead port is NOT bounded to 10s. To keep this test bounded
    // while still driving the datasource's own connect(), we inject the client
    // via the supported `getConnection` option with a short connectionTimeout.
    const { RedisClient } = await import('bun');
    const dead = new StreamingDataSource({
      ...REDIS, port: 63999,
      getConnection: () => new RedisClient('redis://localhost:63999', { idleTimeout: 0, connectionTimeout: 1500 }),
    });
    let err: unknown;
    try {
      await capped(dead.connect(), 10000, 'connect(dead port)');
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toMatch(/^CAP:/); // rejected on its own, not by our cap
    finalizers.push(() => dead.disconnect());
  }, 15000);

  test('(b) double connect() leaves the datasource functional (pin)', async () => {
    // Pinned behavior: a second connect() simply builds fresh connections over the
    // old fields (the first pair is orphaned, not closed — acceptable for a test
    // pin; the contract asserted here is only "still functional afterwards").
    const ds = new StreamingDataSource(REDIS);
    await ds.connect();
    await ds.connect();
    const k = `itest:lifecycle:double:${uniq()}`;
    keys.push(k);
    await writeOne(ds, k, 'dc-1');
    const rs = ds.getReadStream({ stream: k, last: '0', blockingTimeout: 100 });
    let got: MappedStreamEvent | undefined;
    for await (const ev of rs as AsyncIterable<MappedStreamEvent>) { got = ev; break; }
    expect(got?.messageId).toBe('dc-1');
    await ds.abort();
    finalizers.push(() => ds.disconnect());
  }, 15000);

  test('(c) abort() is idempotent; safe on a never-connected source; a fresh source still works', async () => {
    const ds = new StreamingDataSource(REDIS);
    await ds.connect();
    await ds.abort();
    await ds.abort(); // second abort: no throw
    finalizers.push(() => ds.disconnect());

    const never = new StreamingDataSource(REDIS);
    await never.abort(); // never connected: no throw (abort touches no connection)

    // A fresh instance connects and round-trips after the aborts above.
    const fresh = new StreamingDataSource(REDIS);
    await fresh.connect();
    const k = `itest:lifecycle:abort:${uniq()}`;
    keys.push(k);
    await writeOne(fresh, k, 'ab-1');
    const rs = fresh.getReadStream({ stream: k, last: '0', blockingTimeout: 100 });
    let got: MappedStreamEvent | undefined;
    for await (const ev of rs as AsyncIterable<MappedStreamEvent>) { got = ev; break; }
    expect(got?.messageId).toBe('ab-1');
    await fresh.abort();
    finalizers.push(() => fresh.disconnect());
  }, 15000);

  test('(d) control connection serves acks/terminal transitions while the data connection is parked in a blocking read', async () => {
    const topic = new Topic({ namespace: 'itest', topic: `lifecycle-ctrl-${uniq()}` });
    const stream = topic.consumerKey();
    keys.push(stream, topic.producerKey());
    const parkKey = `itest:lifecycle:park:${uniq()}`; // empty stream — the read blocks its full timeout

    const ds = new StreamingDataSource(REDIS); // controllable: true
    await ds.connect();
    finalizers.push(() => ds.disconnect());

    // Two real pending entries, delivered but unacked.
    await ds.createConsumerGroup({ stream, groupId: 'g', cursor: '0' });
    await writeOne(ds, stream, 'p-1');
    await writeOne(ds, stream, 'p-2');
    const delivered = await ds.readGroupEntries(stream, 'g', 'm1', '>', 500);
    expect(delivered.length).toBe(2);

    // Park the DATA connection: blocking XREAD on an empty stream, 4000ms BLOCK.
    const t0 = Date.now();
    const parked = ds.readAsSingle(parkKey, '$', 4000);

    // Both ops route through control_or_client → control; they must complete well
    // before the block would expire.
    expect(await ds.markProcessedByGroup(topic, 'g', delivered[0].streamMessageId!)).toBe(1);
    await ds.respondAndAck({
      producerStream: topic.producerKey(), consumerStream: stream, groupId: 'g',
      streamMessageId: delivered[1].streamMessageId!, messageId: delivered[1].messageId,
      messageType: 'resp', messageSourceId: 'src', payload: JSON.stringify({ ok: true }),
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500); // did not wait out the 4000ms block
    expect((await ds.pendingDetails(stream, 'g')).length).toBe(0);
    await parked; // let the parked read drain before teardown

    // Negative control: controllable:false — the same ops share the single data
    // connection. We only assert they still SUCCEED (Bun pipelines commands on one
    // connection, so exact timing behind a blocking read is implementation detail;
    // observed locally they queue behind the block — not asserted, to avoid flake).
    const topic2 = new Topic({ namespace: 'itest', topic: `lifecycle-noctrl-${uniq()}` });
    keys.push(topic2.consumerKey());
    const nc = new StreamingDataSource({ ...REDIS, controllable: false });
    await nc.connect();
    finalizers.push(() => nc.disconnect());
    await nc.createConsumerGroup({ stream: topic2.consumerKey(), groupId: 'g', cursor: '0' });
    await writeOne(nc, topic2.consumerKey(), 'q-1');
    const d2 = await nc.readGroupEntries(topic2.consumerKey(), 'g', 'm1', '>', 500);
    const parked2 = nc.readAsSingle(`${parkKey}:2`, '$', 2000);
    expect(await capped(nc.markProcessedByGroup(topic2, 'g', d2[0].streamMessageId!), 10000, 'no-ctrl ack')).toBe(1);
    await parked2;
  }, 20000);

  test("(e) a write after disconnect() settles with an error within a bound — never hangs", async () => {
    const ds = new StreamingDataSource(REDIS);
    await ds.connect();
    await ds.disconnect();

    const k = `itest:lifecycle:postdisc:${uniq()}`;
    const ws = ds.getWriteStream({ stream: k });
    const settled = new Promise<Error>((resolve) => {
      ws.on('error', resolve);
      ws.write({
        messageId: 'w-1', messageType: 'data', payload: { a: 1 },
        messageSourceId: 's',
      } as unknown as MappedStreamEvent, (err) => { if (err) resolve(err as Error); });
    });
    const err = await capped(settled, 3000, 'post-disconnect write');
    // The client getter throws "called before initialization" once _client is
    // cleared by disconnect — surfaced through the Writable error path (F2).
    expect(err).toBeInstanceOf(Error);
  }, 10000);
});
