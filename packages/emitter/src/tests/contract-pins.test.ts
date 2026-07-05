import { describe, test } from "bun:test";
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

/**
 * Contract pins (TESTING_ANALYSIS emitter gap 3): behaviors that were implemented
 * but never asserted anywhere — synchronous/uncoalesced notification, `{merge:false}`,
 * `update` isolation vs `set`'s shallow-copy aliasing, and unsubscribe-during-notification
 * safety. These pin the CURRENT verified behavior so future changes are deliberate.
 */

interface S { user: { name: string, age: number }, flags?: { a?: boolean, b?: boolean } }

describe('StateEmitter contract pins', () => {
  test('notification is synchronous and uncoalesced: each update() notifies before it returns', () => {
    const state = new StateEmitter<S>({ user: { name: 'Alice', age: 30 } });
    const seen: string[] = [];
    state.subscribe('user.name', (v) => seen.push(v));

    state.update({ user: { name: 'Bob' } });
    assert.deepStrictEqual(seen, ['Bob']); // already delivered, no microtask needed
    state.update({ user: { name: 'Carol' } });
    assert.deepStrictEqual(seen, ['Bob', 'Carol']); // two updates -> two notifications, never coalesced
  });

  test('update({merge:false}) assigns shallowly: an updated top-level key replaces wholesale', () => {
    const state = new StateEmitter<S>({ user: { name: 'Alice', age: 30 }, flags: { a: true } });
    state.update({ user: { name: 'Bob' } } as any, { merge: false });
    // Shallow assign: `user` is replaced by the partial, dropping `age`.
    assert.deepStrictEqual(state.get('user'), { name: 'Bob' });
    // Untouched top-level keys survive.
    assert.deepStrictEqual(state.get('flags'), { a: true });
  });

  test('update() isolates state from the caller\'s object (JSON round-trip)', () => {
    const state = new StateEmitter<S>({ user: { name: 'Alice', age: 30 } });
    const partial = { user: { name: 'Bob', age: 30 } };
    state.update(partial);
    partial.user.name = 'MUTATED';
    assert.strictEqual(state.get('user.name'), 'Bob'); // caller mutation cannot reach state
  });

  test('set() only shallow-copies: nested objects stay aliased to the caller\'s object (pinned footgun)', () => {
    const state = new StateEmitter<S>({ user: { name: 'Alice', age: 30 } });
    const next = { user: { name: 'Bob', age: 31 } };
    state.set(next as S);
    next.user.name = 'MUTATED';
    // Pinned CURRENT behavior: `set` spreads only the top level, so the nested
    // `user` object is shared with the caller — silent external mutation, no event.
    assert.strictEqual(state.get('user.name'), 'MUTATED');
  });

  test('exclude matching handles the variadic shapes: exact path, trailing wildcard, and mid wildcard', () => {
    const state = new StateEmitter<any>({ a: { b: { c: 1, d: 1 }, e: 1 } });
    const calls: string[] = [];

    state.subscribe('a', () => calls.push('exact'), { exclude: ['a.b.c'] });
    state.update({ a: { b: { c: 2 } } });
    assert.deepStrictEqual(calls, [], 'exact exclude path must suppress the excluded leaf');
    state.update({ a: { e: 2 } });
    assert.deepStrictEqual(calls, ['exact'], 'non-excluded sibling still notifies');

    const midCalls: string[] = [];
    state.subscribe('a', () => midCalls.push('mid'), { exclude: ['a.*.d'] });
    state.update({ a: { b: { d: 3 } } });
    assert.deepStrictEqual(midCalls, [], 'mid-wildcard exclude suppresses a.b.d');
    state.update({ a: { b: { c: 4 } } });
    assert.deepStrictEqual(midCalls, ['mid'], 'mid-wildcard exclude does not over-suppress');
  });

  test("pinned footgun: null/'null' only READ BACK as undefined — the key is never actually removed", () => {
    // The docs describe null/'null' as "deleting" a key. Observed behavior (pinned):
    // neither removes the key. `update({k: null})` keeps the key with value null;
    // `update({k: 'null'})` keeps the key with value undefined (deepMerge maps the
    // string sentinel); `get()` blurs all of it to undefined via `?? undefined`.
    // So a literal "null" string still can't be stored, AND consumers iterating
    // Object.keys(get('*')) will still see the "deleted" keys.
    const state = new StateEmitter<any>({ a: 1, b: 2, c: 3 });
    state.update({ b: null });
    assert.strictEqual(state.get('b'), undefined); // reads as gone...
    assert.deepStrictEqual(Object.keys(state.get('*')).sort(), ['a', 'b', 'c']); // ...but isn't
    assert.strictEqual(state.get('*').b, null);
    state.update({ c: 'null' });
    assert.strictEqual(state.get('c'), undefined);
    assert.ok('c' in state.get('*'));
    assert.strictEqual(state.get('*').c, undefined);
  });

  test('unsubscribing (two-arg API) from inside a notification does not throw and silences future updates', () => {
    const state = new StateEmitter<S>({ user: { name: 'Alice', age: 30 } });
    const calls: string[] = [];
    const second = (v: string) => calls.push(`second:${v}`);
    const first = (v: string) => {
      calls.push(`first:${v}`);
      state.unsubscribe('user.name', second); // removal mid-emit
    };
    state.subscribe('user.name', first);
    state.subscribe('user.name', second);

    state.update({ user: { name: 'Bob' } }); // must not throw
    // Pinned CURRENT behavior (eventemitter3): the same emit still calls the
    // already-collected listener; removal takes effect from the next update.
    assert.deepStrictEqual(calls, ['first:Bob', 'second:Bob']);

    state.update({ user: { name: 'Carol' } });
    assert.deepStrictEqual(calls, ['first:Bob', 'second:Bob', 'first:Carol']);
  });
});
