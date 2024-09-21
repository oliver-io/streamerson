import test from 'node:test';
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

test('StateEmitter Sad Path Tests', async (t) => {
  await t.test('constructor handles empty initial state', () => {
    const state = new StateEmitter({});
    assert.deepStrictEqual(state.get('*'), {});
  });

  await t.test('get returns undefined for non-existent paths', () => {
    const state = new StateEmitter({ user: { name: 'Alice' } });
    assert.strictEqual(state.get('user.age'), undefined);
    assert.strictEqual(state.get('nonexistent.path'), undefined);
  });

  await t.test('get handles invalid paths', () => {
    const state = new StateEmitter({ user: { name: 'Alice' } });
    assert.strictEqual(state.get(''), undefined);
    assert.strictEqual(state.get('.'), undefined);
    assert.strictEqual(state.get('user.'), undefined);
    assert.strictEqual(state.get('.name'), undefined);
  });

  await t.test('update handles empty updates', () => {
    const initialState = { user: { name: 'Alice' } };
    const state = new StateEmitter(initialState);
    state.update({});
    assert.deepStrictEqual(state.get('*'), initialState);
  });

  await t.test('update with non-object values', () => {
    const state = new StateEmitter({ value: 'initial' });
    state.update({ value: 42 } as any);
    assert.strictEqual(state.get('value'), 42);

    state.update({ value: null } as any);
    assert.strictEqual(state.get('value'), null);

    state.update({ value: undefined } as any);
    assert.strictEqual(state.get('value'), undefined);
  });

  await t.test('set with non-object state', () => {
    const state = new StateEmitter({ value: 'initial' });
    assert.throws(() => {
      (state as any).set('not an object');
    }, TypeError);
  });

  await t.test('subscribe with invalid path', async () => {
    const state = new StateEmitter({ user: { name: 'Alice' } });
    let callCount = 0;

    state.subscribe('', () => {
      callCount++;
    });

    state.update({ user: { name: 'Bob' } });

    // Wait for the next event loop to ensure all callbacks have been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(callCount, 0);
  });

  await t.test('subscribe with non-function listener', () => {
    const state = new StateEmitter({ value: 'initial' });
    assert.throws(() => {
      (state as any).subscribe('value', 'not a function');
    }, TypeError);
  });

  await t.test('unsubscribe non-existent listener', () => {
    const state = new StateEmitter({ value: 'initial' });
    const listener = () => {};

    // This should not throw an error
    state.off('change:value', listener);
  });

  await t.test('update with circular reference', () => {
    const state = new StateEmitter<{
      value: string,
      circular?: any
    }>({ value: 'initial' });
    const circularObj: any = { self: null };
    circularObj.self = circularObj;

    assert.throws(() => {
      state.update({ circular: circularObj });
    }, TypeError);
  });

  await t.test('get with very deep nested path', () => {
    const state = new StateEmitter({ a: { b: { c: { d: { e: 'deep' } } } } });
    assert.strictEqual(state.get('a.b.c.d.e'), 'deep');
    assert.strictEqual(state.get('a.b.c.d.e.f'), undefined);
  });

  await t.test('update very deep nested path', async () => {
    const state = new StateEmitter({ a: { b: { c: { d: { e: 'initial' } } } } });
    let callCount = 0;

    state.subscribe('a.b.c.d.e', (newValue, oldValue) => {
      assert.strictEqual(newValue, 'updated');
      assert.strictEqual(oldValue, 'initial');
      callCount++;
    });

    state.update({ a: { b: { c: { d: { e: 'updated' } } } } });

    // Wait for the next event loop to ensure all callbacks have been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(callCount, 1);
  });
});
