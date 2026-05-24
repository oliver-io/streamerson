/**
 * Dynamic stream-set contract — runtime `addStreamId` / `removeStreamId`.
 *
 * Per docs/specs/TESTING.md #10, these are written FIRST, against real Redis, and are
 * EXPECTED TO FAIL on the current implementation. They are the acceptance criteria for
 * the dynamic-stream-set fix (STREAM_PRIMITIVES_REVIEW.md F1) — written so an
 * implementation can be built blind to them: each wrong behaviour mode is rejected by
 * at least one test, and a correct implementation passes all three. They are RED today
 * on purpose (TESTING.md #9 — the suite tells the truth about broken behaviour); no
 * test is marked to pass-by-failing.
 *
 * Contract under test:
 *   - Mutating the set must NOT interrupt the in-flight ingestion of streams that did
 *     NOT change: the original stream keeps flowing across the mutation instant with
 *     no gap, no loss, and no duplication, and the reader is not torn down.
 *   - One or more streams added at runtime are folded into the SAME reader (first
 *     ingestion within ~blockingTimeout), each tagged with its own streamId.
 *   - A removed stream stops being delivered (after the removal takes effect) while the
 *     remaining stream keeps flowing.
 *
 * Behaviour modes rejected (each by ≥1 test): teardown-on-mutate (all); add is a no-op
 * (T2: B/C never delivered); add interrupts/loses the original (T1: gap / no advance);
 * add duplicates the original (T1: duplicates); add mis-tags events (T2: tag); pickup
 * is slow/eventual not prompt (T2: bound); add handles only one pending stream (T2:
 * only one of B/C arrives); remove tears down / is a no-op / also kills the original (T3).
 *
 * Determinism: the failure today is a teardown caused by mutating while the read loop
 * is parked in a blocking read. To make "parked" reliable WITHOUT pausing the original
 * stream (so we test no-interruption of ACTIVE flow), the original is produced at an
 * interval > blockingTimeout — the reader is then in a block essentially 100% of
 * wall-time between messages, so a mutation lands while parked. Assertions are
 * event-driven (resolve the instant the outcome is known).
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
const BLOCK = 100;        // blocking-read cadence; also the new-stream pickup latency bound
const A_INTERVAL = 150;   // > BLOCK, so the reader is parked in a block when we mutate (deterministic teardown today)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let writer: StreamingDataSource;
beforeAll(async () => { writer = new StreamingDataSource({ ...REDIS, controllable: false }); await writer.connect(); });
afterAll(async () => { try { await writer.disconnect(); } catch { /* */ } });

/** Append `prefix-N` (monotonic N) to `key` every `intervalMs` until stopped. */
function startProducer(key: string, prefix: string, intervalMs: number) {
  let stop = false; let i = 0;
  const done = (async () => {
    while (!stop) {
      await writer.writeToStream({ outgoingStream: key, incomingStream: undefined, messageType: 'data' as MessageType, messageId: `${prefix}-${i++}`, message: JSON.stringify({ i }), sourceId: 's' });
      await sleep(intervalMs);
    }
  })();
  return { stop: async () => { stop = true; await done; } };
}

/** Append exactly `prefix-0..n-1` to `key`, awaited (so the produced set is known). */
async function produceN(key: string, prefix: string, n: number) {
  for (let i = 0; i < n; i++) {
    await writer.writeToStream({ outgoingStream: key, incomingStream: undefined, messageType: 'data' as MessageType, messageId: `${prefix}-${i}`, message: JSON.stringify({ i }), sourceId: 's' });
  }
}

/** Poll until `fn` is true or the deadline passes; resolves promptly on the event. */
async function until(fn: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (fn()) return true; await sleep(step); }
  return fn();
}

function readerCtx() {
  const keyA = `itest:dynset:A:${uniq()}`;
  const keyB = `itest:dynset:B:${uniq()}`;
  const reader = new StreamingDataSource(REDIS);
  const received: Array<{ stream?: string; id: string }> = [];
  const life = { ended: false, closed: false, errored: null as Error | null };
  return {
    keyA, keyB, reader, received, life,
    tornDown: () => life.ended || life.closed,
    has: (prefix: string) => received.some((r) => r.id.startsWith(prefix)),
    first: (prefix: string) => received.find((r) => r.id.startsWith(prefix)),
    /** Highest monotonic index seen for `prefix` (e.g. 'a-'), or -1. */
    maxIdx: (prefix: string) => received.reduce((m, r) => (r.id.startsWith(prefix) ? Math.max(m, Number(r.id.slice(prefix.length))) : m), -1),
  };
}
type Ctx = ReturnType<typeof readerCtx>;

/**
 * Stand up a reader tailing stream A from the start, with A flowing continuously at an
 * interval > blockingTimeout (so the reader is parked in a block between messages), and
 * wait until the loop is established. The caller then mutates the set while A is live.
 */
async function establishReaderOnA(): Promise<{ ctx: Ctx; aProducer: ReturnType<typeof startProducer> }> {
  const ctx = readerCtx();
  await ctx.reader.connect();
  const stream = ctx.reader.getReadStream({ stream: ctx.keyA, last: '0', blockingTimeout: BLOCK });
  stream.on('data', (ev: MappedStreamEvent) => ctx.received.push({ stream: ev.streamId, id: ev.messageId }));
  stream.on('end', () => { ctx.life.ended = true; });
  stream.on('close', () => { ctx.life.closed = true; });
  stream.on('error', (e: Error) => { ctx.life.errored = e; });

  const aProducer = startProducer(ctx.keyA, 'a', A_INTERVAL);
  await until(() => ctx.maxIdx('a-') >= 4, 5000); // loop established and tailing A in order
  return { ctx, aProducer };
}

async function cleanup(ctx: Ctx, ...extraKeys: string[]) {
  try { ctx.reader.abort(); } catch { /* */ }
  await sleep(50);
  try { await ctx.reader.disconnect(); } catch { /* */ }
  try { await writer.client.send('DEL', [ctx.keyA, ctx.keyB, ...extraKeys]); } catch { /* */ }
}

describe('dynamic stream-set contract (runtime add/remove)', () => {
  test('addStreamId does not interrupt the in-flight original stream (no gap, no loss, no dup, no teardown)', async () => {
    const { ctx, aProducer } = await establishReaderOnA();
    try {
      const H1 = ctx.maxIdx('a-');               // high-water of the original stream before the mutation
      ctx.reader.addStreamId(ctx.keyB);          // mutate WHILE A is actively flowing (reader parked → today: teardown)
      const bProducer = startProducer(ctx.keyB, 'b', 100); // B begins tailing alongside A
      // Resolve the instant the outcome is known: A advanced well past the mutation, or the reader died.
      await until(() => ctx.tornDown() || ctx.maxIdx('a-') >= H1 + 15, 8000);
      await aProducer.stop(); await bProducer.stop();

      const aIdx = [...new Set(ctx.received.filter((r) => r.id.startsWith('a-')).map((r) => Number(r.id.slice(2))))].sort((x, y) => x - y);
      const afterMutation = aIdx.filter((i) => i > H1);
      const maxIdx = afterMutation.length ? afterMutation[afterMutation.length - 1] : H1;
      const rawA = ctx.received.filter((r) => r.id.startsWith('a-')).map((r) => r.id);

      expect({
        tornDown: ctx.tornDown(),
        advancedAcrossMutation: (maxIdx - H1) >= 12,                  // original stream kept flowing through the add
        gaplessAcrossMutation: afterMutation.length === (maxIdx - H1), // every index in (H1, maxIdx] present — no loss/interruption
        duplicates: rawA.length - new Set(rawA).size,
      }).toEqual({ tornDown: false, advancedAcrossMutation: true, gaplessAcrossMutation: true, duplicates: 0 });
    } finally { await cleanup(ctx); }
  }, 25000);

  test('multiple streams added at runtime are all ingested through the same reader, tagged, within ~blockingTimeout', async () => {
    const { ctx, aProducer } = await establishReaderOnA();
    const keyC = `itest:dynset:C:${uniq()}`;
    try {
      ctx.reader.addStreamId(ctx.keyB);
      ctx.reader.addStreamId(keyC);              // rapid succession — exercises the SET, not a single pending slot
      const t = Date.now();
      const bP = startProducer(ctx.keyB, 'b', 100);
      const cP = startProducer(keyC, 'c', 100);
      await until(() => ctx.tornDown() || (ctx.has('b-') && ctx.has('c-')), 8000);
      const delay = Date.now() - t;
      const firstB = ctx.first('b-');
      const firstC = ctx.first('c-');
      await aProducer.stop(); await bP.stop(); await cP.stop();

      expect({
        tornDown: ctx.tornDown(),
        bDelivered: !!firstB,
        cDelivered: !!firstC,
        bTaggedToOwnStream: firstB ? firstB.stream === ctx.keyB : false,
        cTaggedToOwnStream: firstC ? firstC.stream === keyC : false,
        pickupWithinBound: delay < 2000,         // prompt next-cycle pickup, not slow/eventual
      }).toEqual({ tornDown: false, bDelivered: true, cDelivered: true, bTaggedToOwnStream: true, cTaggedToOwnStream: true, pickupWithinBound: true });
    } finally { await cleanup(ctx, keyC); }
  }, 25000);

  test('removeStreamId stops the removed stream while the original keeps flowing', async () => {
    const { ctx, aProducer } = await establishReaderOnA();
    try {
      ctx.reader.addStreamId(ctx.keyB);
      const bP = startProducer(ctx.keyB, 'b', 100);
      await until(() => ctx.tornDown() || ctx.has('b-'), 8000);
      const bothFlowed = !ctx.tornDown() && ctx.has('b-'); // requires add to have worked (B picked up) and A alive
      await bP.stop();

      ctx.reader.removeStreamId(ctx.keyB);
      await sleep(BLOCK + 50);                    // let the removal take effect at a cycle boundary
      const aAtRemove = ctx.maxIdx('a-');
      await produceN(ctx.keyB, 'bx', 6);          // produced AFTER removal — must NOT be delivered
      await until(() => ctx.tornDown() || ctx.maxIdx('a-') > aAtRemove, 4000);
      await aProducer.stop();

      expect({
        tornDown: ctx.tornDown(),
        bothFlowedBeforeRemoval: bothFlowed,
        removedStreamDeliveredAfterRemoval: ctx.received.filter((r) => r.id.startsWith('bx-')).length,
        originalKeptFlowing: ctx.maxIdx('a-') > aAtRemove,
      }).toEqual({ tornDown: false, bothFlowedBeforeRemoval: true, removedStreamDeliveredAfterRemoval: 0, originalKeptFlowing: true });
    } finally { await cleanup(ctx); }
  }, 25000);
});
