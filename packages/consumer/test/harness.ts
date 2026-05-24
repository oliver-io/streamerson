/**
 * Shared integration-test harness for the consumer-group suite (TESTING.md §5:
 * absorb setup into a reused harness, not re-declared per file). Everything here
 * drives the real classes against a live Redis (`bun run start:redis`) and asserts
 * on Redis ground truth (XPENDING / XRANGE / XINFO) — never on framework bookkeeping.
 *
 * Prefer `until(predicate, ms)` over a fixed `sleep` before a positive-result
 * assertion: it ends as soon as the condition holds and only times out on genuine
 * failure (TESTING.md §6 — avoid arbitrary waiting). A fixed `sleep` is appropriate
 * only for a negative/stability check (give a forbidden event a window, then assert
 * it did not happen).
 */
import { StreamingDataSource, Topic } from '@streamerson/core';
import type { MappedStreamEvent, MessageType } from '@streamerson/core';

export const REDIS = {
  host: process.env['STREAMERSON_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['STREAMERSON_REDIS_PORT'] ?? 6379),
  controllable: true,
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` until it returns true or `ms` elapses; resolves to the final result. */
export async function until(fn: () => boolean | Promise<boolean>, ms: number, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return await fn();
}

/** A unique `itest` topic so repeated/parallel runs never collide on keys. */
export function makeTopic(tag: string): Topic {
  return new Topic({ namespace: 'itest', topic: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
}

/** XPENDING summary total for a group on the topic's consumer (request) key. */
export async function pendingCount(admin: StreamingDataSource, topic: Topic, group: string): Promise<number> {
  const r = await admin.client.send('XPENDING', [topic.consumerKey(), group]);
  return Array.isArray(r) ? Number(r[0]) : 0;
}

/** XLEN of any stream key (0 for a missing key). */
export async function xlen(admin: StreamingDataSource, key: string): Promise<number> {
  return Number((await admin.client.send('XLEN', [key])) ?? 0);
}

/** XRANGE the dead-letter stream → field maps (keyed by `messageId` etc.). */
export async function readDlq(admin: StreamingDataSource, topic: Topic): Promise<Array<Record<string, string>>> {
  const reply = await admin.client.send('XRANGE', [topic.deadLetterKey(), '-', '+']) as Array<[string, string[]]>;
  return (reply ?? []).map(([, kv]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i + 1 < kv.length; i += 2) f[kv[i]] = kv[i + 1];
    return f;
  });
}

/** Write a request onto the topic's consumer (request) stream. */
export async function write(admin: StreamingDataSource, topic: Topic, messageType: string, messageId: string, payload: object): Promise<void> {
  await admin.writeToStream({
    outgoingStream: topic.consumerKey(),
    incomingStream: topic.producerKey(),
    messageType: messageType as MessageType,
    messageId,
    message: JSON.stringify(payload),
    sourceId: 'test',
  });
}

/**
 * Produce one entry and deliver it to a phantom group consumer that never acks, so it
 * is left abandoned in that consumer's PEL with its idle clock ticking — the precondition
 * for reaper/reclaim tests. The raw XREADGROUP from a throwaway consumer simulates a
 * member that took the message and then crashed.
 */
export async function abandonToPhantom(
  admin: StreamingDataSource, topic: Topic, group: string, messageId: string, consumer = 'phantom',
): Promise<void> {
  await write(admin, topic, 'orphan', messageId, { v: 1 });
  await admin.client.send('XREADGROUP', ['GROUP', group, consumer, 'COUNT', '1', 'STREAMS', topic.consumerKey(), '>']);
}

/** Collect distinct response messageIds off the producer key until `want` or timeout. */
export async function collectResponses(topic: Topic, want: number, ms: number): Promise<Set<string>> {
  const reader = new StreamingDataSource(REDIS);
  await reader.connect();
  const seen = new Set<string>();
  const stream = reader.getReadStream({ stream: topic.producerKey(), last: '0' });
  const loop = (async () => {
    for await (const ev of stream as AsyncIterable<MappedStreamEvent>) {
      if (ev.messageId) seen.add(ev.messageId);
      if (seen.size >= want) break;
    }
  })();
  await Promise.race([loop, sleep(ms)]);
  try { reader.abort(); } catch { /* */ }
  try { await reader.disconnect(); } catch { /* */ }
  return seen;
}

/** Wait for one correlated response (by `messageId`) off the producer key. */
export async function awaitResponse(topic: Topic, messageId: string, ms: number): Promise<MappedStreamEvent | undefined> {
  const reader = new StreamingDataSource(REDIS);
  await reader.connect();
  const stream = reader.getReadStream({ stream: topic.producerKey(), last: '0' });
  const found = (async () => {
    for await (const ev of stream as AsyncIterable<MappedStreamEvent>) {
      if (ev.messageId === messageId) return ev;
    }
    return undefined;
  })();
  const got = await Promise.race([found, sleep(ms).then(() => undefined)]);
  try { reader.abort(); } catch { /* */ }
  try { await reader.disconnect(); } catch { /* */ }
  return got;
}

/** Delete a topic's consumer / producer / dead-letter keys (teardown). */
export async function cleanupKeys(admin: StreamingDataSource, topic: Topic): Promise<void> {
  try { await admin.client.send('DEL', [topic.consumerKey(), topic.producerKey(), topic.deadLetterKey()]); } catch { /* */ }
}

/** XINFO CONSUMERS → consumer names (robust across RESP2/RESP3 reply shapes). */
export function consumerNames(reply: unknown): string[] {
  if (!Array.isArray(reply)) return [];
  return reply.map((c: any) => {
    if (c && typeof c === 'object' && !Array.isArray(c)) return String(c.name);
    if (Array.isArray(c)) { const i = c.indexOf('name'); return i >= 0 ? String(c[i + 1]) : ''; }
    return '';
  });
}

/**
 * A per-file integration rig: one admin data source plus deferred teardown, centralising
 * the connect → disconnect-everything → settle → delete-keys dance that otherwise repeats
 * in every integration file (TESTING.md §5). Tracked closers run LIFO, then a short settle
 * lets in-flight blocking reads observe `closing` BEFORE the tracked topics' keys are
 * deleted and the admin connection closes (disconnect-before-delete avoids NOGROUP noise).
 *
 *   const rig = testRig();
 *   const admin = rig.admin;                 // keep test bodies reading as before
 *   beforeAll(() => rig.connect());
 *   afterAll(() => rig.teardown());
 *   // in a test:
 *   const topic = rig.topic('foo');                          // deleted at teardown
 *   const member = rig.track(new ConsumerGroupMember(...));  // disconnected at teardown
 */
export function testRig() {
  const admin = new StreamingDataSource(REDIS);
  const topics: Topic[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  return {
    admin,
    /** Track a closeable (member / coordinator / consumer) for disconnect at teardown. */
    track<T extends { disconnect(): Promise<void> | void }>(c: T): T {
      closers.push(() => c.disconnect());
      return c;
    },
    /** Register an arbitrary teardown closer (runs LIFO alongside tracked disconnects). */
    onTeardown(fn: () => Promise<void> | void): void { closers.push(fn); },
    /** A unique tracked topic whose three keys are deleted at teardown. */
    topic(tag: string): Topic { const t = makeTopic(tag); topics.push(t); return t; },
    connect(): Promise<unknown> { return admin.connect(); },
    async teardown(): Promise<void> {
      for (const fn of [...closers].reverse()) { try { await fn(); } catch { /* */ } }
      await sleep(150);
      for (const t of topics) { await cleanupKeys(admin, t); }
      try { await admin.disconnect(); } catch { /* */ }
    },
  };
}
