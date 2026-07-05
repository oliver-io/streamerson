/**
 * DeferralTracker edge coverage — direct use of the public unit (no Redis needed):
 * (a) errorEvent's unknown-id orphan pre-stores `self: Promise.reject(event)` with a
 *     noop reject — a poisoned orphan that nothing can ever observe;
 * (b) cancelAll over a mixed population (real deferrals + orphans);
 * (c) id collision shares one deferral.
 * Style matches the deferred-stream-consumer suite (quiet logger, until(), bounded waits).
 */
import { test, expect } from 'bun:test';
import { DeferralTracker } from '../../../src';

const quiet = { info() {}, debug() {}, warn() {}, error() {}, child() { return quiet; }, level: 'silent' } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Collect unhandled rejections over a window; detach afterwards. */
function trapUnhandled() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  return { seen, detach: () => { process.off('unhandledRejection', onUnhandled); } };
}

test('(a) errorEvent with an unknown messageId must not produce an unhandled rejection (poisoned-orphan hazard)', async () => {
  // INTENDED CONTRACT: an unsolicited/late error for an id nobody awaits is dropped or
  // parked benignly — it must never surface as a process-level unhandled rejection.
  // THE CODE (deferred-promise-tracker.ts errorEvent, else-branch) pre-stores
  //   { self: Promise.reject(event), reject: noOpFunction, ... }
  // — a rejected promise NO consumer can ever attach to (promise(id) would return it, but
  // an errorEvent orphan exists precisely because nobody called promise(id)). If the
  // runtime surfaces it, that is a genuine product defect (poisoned orphan): this test
  // then stays RED against the intended contract. Evidence: the noop `reject` means even
  // cancel/delete cannot observe `self`; only a subsequent promise('ghost') call could,
  // and none occurs on this path in dispatch().
  //
  // *** RED — CONFIRMED PRODUCT DEFECT (verified 2026-07-03, Bun 1.3.14) ***
  // Standalone reduction (no test harness): `new DeferralTracker({timeout:100}); tracker.emit(
  // 'error', {messageId:'ghost', payload:{message:'boom'}})` fires process 'unhandledRejection'
  // with the event as reason within one tick — the pre-stored `Promise.reject(event)` at
  // deferred-promise-tracker.ts errorEvent else-branch is never observed by anyone. Bun's test
  // runner additionally attributes that unhandled rejection to the running test and fails it
  // outright (even with a process listener attached), which is why this test reports failure
  // before the assertions below. Fix direction: pre-store the rejection lazily (arm `self` as a
  // pre-observed promise, e.g. attach a noop .catch, or store the event and reject only when a
  // consumer calls promise(id)). Leave RED until fixed.
  const tracker = new DeferralTracker({ timeout: 100, logger: quiet });
  const trap = trapUnhandled();
  try {
    tracker.emit('error', { messageId: 'ghost-err-1', payload: { message: 'boom' } } as any);
    expect('ghost-err-1' in tracker.promises).toBe(true); // orphan parked
    // Unhandled rejections surface on later ticks; hold a window past the orphan's
    // self-delete (timeout*2 = 200ms) so both the rejection and the timer settle.
    await sleep(400);
    expect('ghost-err-1' in tracker.promises).toBe(false); // self-deleted
    expect(trap.seen).toEqual([]); // INTENDED: no unhandled rejection escapes
  } finally {
    trap.detach();
    tracker.cancelAll();
    tracker.removeAllListeners();
  }
});

test('(b) cancelAll over a mixed population: 200 real deferrals + 5 orphans all cancel cleanly, no late timers', async () => {
  const tracker = new DeferralTracker({ timeout: 150, logger: quiet });
  const trap = trapUnhandled();
  try {
    const N = 200;
    const outcomes: Promise<string>[] = [];
    for (let i = 0; i < N; i++) {
      outcomes.push(tracker.promise(`real-${i}`).then(
        () => 'resolved',
        (e: Error) => e.message,
      ));
    }
    // 5 orphans via responseEvent for unknown ids (noop-reject pre-store entries).
    for (let i = 0; i < 5; i++) tracker.emit('response', { messageId: `orphan-${i}`, payload: {} } as any);
    await until(() => Object.keys(tracker.promises).length === N + 5, 2000, 'full population');

    tracker.cancelAll('teardown');

    const results = await Promise.all(outcomes);
    for (const r of results) expect(r).toBe('CANCELLED: teardown'); // every REAL deferral rejects
    expect(Object.keys(tracker.promises)).toEqual([]); // map empty (orphans deleted too)

    // Stability window past every armed timer horizon (deferral 150ms, orphan 300ms):
    // no timer fires later, no unhandled rejection leaks.
    await sleep(400);
    expect(Object.keys(tracker.promises)).toEqual([]);
    expect(trap.seen).toEqual([]);
  } finally {
    trap.detach();
    tracker.removeAllListeners();
  }
});

test('(c) id collision shares one deferral: promise("x") twice, one response resolves both with the same event', async () => {
  const tracker = new DeferralTracker({ timeout: 2000, logger: quiet });
  const p1 = tracker.promise('x');
  const p2 = tracker.promise('x'); // second call returns the SAME tracked promise
  expect(Object.keys(tracker.promises)).toEqual(['x']);

  const event = { messageId: 'x', payload: { ok: true } };
  tracker.emit('response', event as any);

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toBe(r2 as any);      // identical event object, one shared deferral
  expect((r1 as any).payload.ok).toBe(true);

  tracker.delete('x');
  tracker.removeAllListeners();
});
