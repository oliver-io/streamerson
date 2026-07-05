/**
 * Iterator termination while PARKED in a blocking read (audit gap 8 / CG-I1 surface).
 *
 * Intended contract: getReadStream's doc comment invites "Consume it as an
 * async-iterable" — so consumer-side termination (for-await `break`, which calls the
 * iterator's `return()`, or `Readable.destroy()`) must end the underlying read loop:
 * within ~one blockingTimeout the loop exits and iterateStream's `finally` removes
 * BOTH keyEvents listeners ('update' AND 'abort'; KeyEvents.CANCEL === 'abort' —
 * iterate-stream-listeners.test.ts only checks 'update', and only via abort()).
 *
 * OBSERVED (verified, Bun 1.3.14 — probe evidence):
 *   1. Bun's Readable.from DOES propagate teardown to the source generator: with a
 *      plain async generator (yielding every 30ms), both `break` and `destroy()` run
 *      the generator's `finally` promptly. The harness path is sound.
 *   2. With the REAL datasource, after `break` the listeners stay at {update:1,
 *      abort:1} for >6s (sampled at 0.1/0.4/0.8/1.5/3s) — iterateStream's `finally`
 *      NEVER runs, even though the Readable reports destroyed=true.
 * Root cause (product, not harness): per async-generator semantics, a `return()`
 * requested while the generator is suspended at an `await` is only injected at the
 * next YIELD. An idle reader loops `await Promise.race([blocking read, wake])` and —
 * with no events — never reaches a yield; `wake()` fires only on CANCEL (the
 * iterateStream doc: "wake() is reserved for CANCEL"). So consumer-side termination
 * orphans the read loop FOREVER: a destroyed Readable whose loop keeps issuing
 * blocking XREADs and holding listeners. Tests 1–2 are therefore RED against the
 * intended contract (a supported consumption mode must not leak a permanent read
 * loop); test 3 pins abort() — the CANCEL path — as the working teardown.
 *
 * Requires Redis on localhost:6379 (`bun run start:redis`).
 */
import { test, expect, afterAll, describe } from 'bun:test';
import { StreamingDataSource } from '../../../src';
import type { MappedStreamEvent, MessageType } from '../../../src/types';

const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 300;

// Each test gets its OWN datasource so an orphaned read loop (the defect under test)
// cannot contaminate the next test's listener counts.
const opened: StreamingDataSource[] = [];
const keys: string[] = [];
async function freshDs() {
  const ds = new StreamingDataSource(REDIS);
  await ds.connect();
  opened.push(ds);
  return ds;
}

afterAll(async () => {
  // abort() (CANCEL) is the working teardown — it also reaps any orphaned loops.
  for (const ds of opened) { try { await ds.abort(); } catch { /* teardown */ } }
  await sleep(150);
  try { if (keys.length && opened[0]) await opened[0].client.send('DEL', keys); } catch { /* teardown */ }
  for (const ds of opened) { try { await ds.disconnect(); } catch { /* teardown */ } }
});

async function until(cond: () => boolean, ms: number, step = 20) {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (cond()) return true; await sleep(step); }
  return cond();
}
const listenerCounts = (ds: StreamingDataSource) => ({
  update: ds.keyEvents.listenerCount('update'),
  abort: ds.keyEvents.listenerCount('abort'),
});

describe('iterator termination while parked (gap 8)', () => {
  test('RED (known defect): break out of for-await ends the read loop — listeners must return to 0 within ~one blockingTimeout', async () => {
    const ds = await freshDs();
    const key = `itest:iterterm:break:${uniq()}`;
    keys.push(key);
    // One entry so the for-await body runs and `break` executes; read-ahead has
    // already parked the loop in the next blocking read when the break fires.
    await ds.writeToStream({
      outgoingStream: key, incomingStream: undefined,
      messageType: 'data' as MessageType, messageId: 'only-1',
      message: JSON.stringify({}), sourceId: 'iterterm',
    });
    const stream = ds.getReadStream({ stream: key, last: '0', blockingTimeout: BLOCK });

    let sawEntry = false;
    for await (const ev of stream as AsyncIterable<MappedStreamEvent>) {
      sawEntry = ev.messageId === 'only-1';
      break; // → iterator.return() → Readable destroy → generator return() requested
    }
    expect(sawEntry).toBe(true);
    expect(stream.destroyed).toBe(true); // the Readable itself tears down promptly

    // INTENDED: the underlying loop ends and iterateStream's finally removes both
    // listeners within ~one BLOCK. OBSERVED: return() is never injected (no yield is
    // ever reached on the idle stream), the loop is orphaned, and counts stay at 1/1
    // indefinitely (probe: unchanged after 6s). RED — product defect, not harness
    // (plain-generator probe shows Bun propagates return() fine).
    expect(await until(() => {
      const c = listenerCounts(ds);
      return c.update === 0 && c.abort === 0;
    }, BLOCK + 700)).toBe(true);
  }, 15000);

  test('RED (known defect): Readable.destroy() while parked ends the read loop — listeners must return to 0 within ~one blockingTimeout', async () => {
    const ds = await freshDs();
    const key = `itest:iterterm:destroy:${uniq()}`;
    keys.push(key);
    const stream = ds.getReadStream({ stream: key, last: '$', blockingTimeout: BLOCK });
    let closed = false;
    stream.on('close', () => { closed = true; });
    stream.on('data', () => { /* none expected */ });
    stream.on('error', () => { /* premature-close from destroy is irrelevant here */ });

    // Empty stream + BLOCK=300: after 150ms the loop is deterministically mid-block.
    await sleep(150);
    expect(listenerCounts(ds)).toEqual({ update: 1, abort: 1 }); // loop live before destroy

    stream.destroy();
    expect(await until(() => closed, BLOCK + 700)).toBe(true); // the Readable closes...

    // ...but INTENDED loop teardown never happens: same orphaning as the break path
    // (destroy() also lands as a generator return() at an await, never injected). RED.
    expect(await until(() => {
      const c = listenerCounts(ds);
      return c.update === 0 && c.abort === 0;
    }, BLOCK + 700)).toBe(true);
  }, 15000);

  test('abort() (CANCEL) is the working teardown: a parked reader exits promptly and removes both listeners', async () => {
    const ds = await freshDs();
    const key = `itest:iterterm:abort:${uniq()}`;
    keys.push(key);
    const stream = ds.getReadStream({ stream: key, last: '$', blockingTimeout: BLOCK });
    let loopExited = false;
    const loop = (async () => {
      for await (const _ of stream as AsyncIterable<unknown>) { void _; }
    })().catch(() => { /* teardown may surface as an iterator error */ }).finally(() => { loopExited = true; });

    await sleep(150); // parked mid-block
    expect(listenerCounts(ds)).toEqual({ update: 1, abort: 1 });

    const t = Date.now();
    await ds.abort(); // CANCEL: wake() interrupts the parked read — prompt, not BLOCK-bound
    await Promise.race([loop, sleep(BLOCK + 700)]);

    expect(loopExited).toBe(true);
    expect(Date.now() - t).toBeLessThanOrEqual(BLOCK + 700);
    expect(await until(() => {
      const c = listenerCounts(ds);
      return c.update === 0 && c.abort === 0;
    }, 500)).toBe(true);
  }, 15000);
});
