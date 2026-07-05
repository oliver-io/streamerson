import { describe, test } from "bun:test";
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

/**
 * Edge semantics: null-root holes, subtree replacement, type transitions, array
 * shrink/identity, set add/remove, subscriber-throw blast radius, ordering,
 * bracket-syntax exclude, and dotted-key hazards. RED tests assert the intended
 * contract and carry evidence comments; PIN tests freeze observed behavior.
 */

describe('StateEmitter edge semantics', () => {
  test('RED: constructor rejects the JSON null root like other non-object roots', () => {
    // INTENDED CONTRACT: `new StateEmitter('"str"')` and `new StateEmitter('[]')`
    // throw TypeError; a null root should too. DEFECT (emitter.ts valueFromUpdate):
    // JSON.parse('null') is null, `typeof null === 'object'` and !Array.isArray(null),
    // so the gate passes and `this.state = null` — every later `{...this.state}`
    // silently launders it to {}. Verified: construction currently succeeds.
    assert.throws(() => new StateEmitter('null' as any), TypeError);
  });

  test('RED: update(null) must not nuke state (reject like update(\'"str"\'))', () => {
    // INTENDED CONTRACT: non-object update payloads throw TypeError and leave
    // state untouched. DEFECT: valueFromUpdate(null) passes the gate (same null
    // hole as above), then deepMerge(state, null) hits the
    // `!isObject(source) → return source` branch and REPLACES state with null.
    // Verified: get('a') becomes undefined and get('*') is {} (spread of null).
    const state = new StateEmitter<any>({ a: 1 });
    try {
      state.update(null as any);
    } catch (err) {
      assert.ok(err instanceof TypeError);
    }
    // Whether or not it threw, state must be preserved.
    assert.strictEqual(state.get('a'), 1, `state was nuked: get('*') = ${JSON.stringify(state.get('*'))}`);
  });

  test('PIN (documented gap): replacing a whole subtree does not notify descendant subscribers', () => {
    // Deleting `user` via the 'null' sentinel changes only the path 'user' per
    // getChangedPaths (one side non-object → single path), and getAllAffectedPaths
    // only expands ANCESTORS, never children. So a 'user.name' subscriber is not
    // told its value went away. Unstated semantics — the README promises deep
    // subscription but says nothing about parent-removal fan-down — so we PIN it.
    const state = new StateEmitter<any>({ user: { name: 'Alice' } });
    const nameEvents: any[] = [];
    const userEvents: any[] = [];
    state.subscribe('user.name', (n, o) => nameEvents.push([n, o]));
    state.subscribe('user', (n, o) => userEvents.push([n, o]));

    state.update({ user: 'null' } as any);
    assert.deepStrictEqual(userEvents, [[undefined, { name: 'Alice' }]]);
    assert.deepStrictEqual(nameEvents, [], 'pinned gap: no change:user.name on subtree removal');
    assert.strictEqual(state.get('user.name'), undefined);
  });

  test('object -> scalar -> object transitions emit change:<path> with correct (new, old) and do not crash', () => {
    const state = new StateEmitter<any>({ user: { name: 'Alice' } });
    const events: any[] = [];
    state.subscribe('user', (n, o) => events.push([n, o]));

    state.update({ user: 5 } as any);
    assert.deepStrictEqual(events, [[5, { name: 'Alice' }]]);
    assert.strictEqual(state.get('user'), 5);

    state.update({ user: { name: 'Bob' } });
    assert.deepStrictEqual(events, [[5, { name: 'Alice' }], [{ name: 'Bob' }, 5]]);
    assert.strictEqual(state.get('user.name'), 'Bob');
  });

  test('PIN: array shrink emits change:<arr> only — no removal events for dropped indices', () => {
    // emitChanges iterates only the NEW array's indices, so arr[1]/arr[2]
    // subscribers are never told their elements vanished.
    const state = new StateEmitter<any>({ arr: [1, 2, 3] });
    const arrEvents: any[] = [];
    const dropped: any[] = [];
    state.subscribe('arr', (n, o) => arrEvents.push([n, o]));
    state.subscribe('arr[1]', (n, o) => dropped.push(['arr[1]', n, o]));
    state.subscribe('arr[2]', (n, o) => dropped.push(['arr[2]', n, o]));

    state.update({ arr: [1] });
    assert.deepStrictEqual(arrEvents, [[[1], [1, 2, 3]]]);
    assert.deepStrictEqual(dropped, [], 'pinned: no removal events for shrunk-away indices');
    assert.deepStrictEqual(state.get('arr'), [1]);
  });

  test('PIN (known sharp edge): updating an array with identical contents still emits change:<arr>', () => {
    // The update payload is JSON round-tripped and assigned wholesale, so the
    // array is a fresh identity; getChangedPaths compares arrays with Object.is
    // (arrays fail isObject), not by contents — so equal contents still "change".
    // Element-level events correctly stay silent (leaf Object.is comparison).
    const state = new StateEmitter<any>({ arr: [1, 2] });
    const arrEvents: any[] = [];
    const elemEvents: any[] = [];
    state.subscribe('arr', (n, o) => arrEvents.push([n, o]));
    state.subscribe('arr[0]', (n, o) => elemEvents.push([n, o]));

    state.update({ arr: [1, 2] });
    assert.deepStrictEqual(arrEvents, [[[1, 2], [1, 2]]], 'pinned: spurious change:arr on identical contents');
    assert.deepStrictEqual(elemEvents, []);
  });

  test('set() emits removal (undefined, old) for keys that disappear and (new, undefined) for keys that appear', () => {
    const state = new StateEmitter<any>({ a: 1, b: 2 });
    const events: Record<string, any[]> = { b: [], c: [] };
    state.subscribe('b', (n, o) => events.b.push([n, o]));
    state.subscribe('c', (n, o) => events.c.push([n, o]));

    state.set({ a: 1, c: 3 });
    assert.deepStrictEqual(events.b, [[undefined, 2]]);
    assert.deepStrictEqual(events.c, [[3, undefined]]);
    assert.strictEqual(state.get('b'), undefined);
    assert.strictEqual(state.get('c'), 3);
  });

  test('PIN (blast radius): a throwing subscriber aborts update() mid-emit — later listeners and \'*\' starve, state already mutated', () => {
    // eventemitter3's emit has no isolation: listener A's throw propagates out of
    // emit → emitChanges → update. B (registered after A on the same path) is
    // never called for that emit, the trailing 'stateChange' never fires, and the
    // state assignment happened BEFORE emitChanges — so state is already 'Bob'.
    const state = new StateEmitter<any>({ user: { name: 'Alice' } });
    const seen: string[] = [];
    state.subscribe('user.name', () => { seen.push('A'); throw new Error('boom'); });
    state.subscribe('user.name', () => seen.push('B'));
    state.subscribe('*', () => seen.push('*'));

    assert.throws(() => state.update({ user: { name: 'Bob' } }), /boom/);
    assert.deepStrictEqual(seen, ['A'], 'pinned: B and * starved by A\'s throw');
    assert.strictEqual(state.get('user.name'), 'Bob', 'pinned: state mutated despite notification failure');
  });

  test('subscribers on one path are notified in subscription order', () => {
    const state = new StateEmitter<any>({ x: 1 });
    const order: string[] = [];
    state.subscribe('x', () => order.push('A'));
    state.subscribe('x', () => order.push('B'));
    state.update({ x: 2 });
    assert.deepStrictEqual(order, ['A', 'B']);
  });

  test('PIN (known sharp edge): exclude with bracket syntax never matches — listener still fires', () => {
    // matchesExcludePath splits both paths on '.'; the exclude part 'items[0]'
    // never string-equals any dot-segment, and the changed path reported to the
    // wrapped listener for an array leaf is '' anyway. Bracket-syntax excludes
    // are silently inert.
    const state = new StateEmitter<any>({ items: [1, 2] });
    let fired = 0;
    state.subscribe('items', () => fired++, { exclude: ['items[0]'] });
    state.update({ items: [5, 2] });
    assert.strictEqual(fired, 1, 'pinned: bracket exclude is inert; listener fires anyway');
  });

  test('PIN (hazard): a literal dotted key \'a.b\' emits under path a.b AND a phantom change:a', () => {
    // getChangedPaths yields the literal key 'a.b' as one path, but
    // getAllAffectedPaths splits on '.' and fabricates ancestor 'a' — which does
    // not exist — so change:a fires with (undefined, undefined). The 'a.b' event
    // itself carries correct values because lodash.get resolves 'a.b' as a DIRECT
    // key when one exists on the object (isKey's `value in object` check), only
    // falling back to nested resolution otherwise. Mis-resolution hazard: if a
    // nested {a:{b:...}} coexisted, the literal key would shadow it.
    const state = new StateEmitter<any>({ 'a.b': 1 });
    const abEvents: any[] = [];
    const aEvents: any[] = [];
    state.subscribe('a.b', (n, o) => abEvents.push([n, o]));
    state.subscribe('a', (n, o) => aEvents.push([n, o]));

    state.update({ 'a.b': 2 } as any);
    assert.deepStrictEqual(abEvents, [[2, 1]]);
    assert.deepStrictEqual(aEvents, [[undefined, undefined]], 'pinned: phantom ancestor event for a nonexistent path');
    assert.strictEqual(state.get('a.b'), 2);
    assert.deepStrictEqual(state.get('*'), { 'a.b': 2 });
  });
});
