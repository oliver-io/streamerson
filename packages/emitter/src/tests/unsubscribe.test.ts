import { describe, test } from "bun:test";
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

interface SomeUserRecord {
  user: { name: string, age: number },
  isLoggedIn?: boolean
}

describe('StateEmitter unsubscribe', () => {
  test('two-arg unsubscribe(path, listener) with the original listener removes it', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    let calls = 0;
    const listener = () => { calls++; };
    state.subscribe('user.name', listener);
    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(calls, 1);
    state.unsubscribe('user.name', listener);
    state.update({ user: { name: 'Carol' } });
    assert.strictEqual(calls, 1);
    assert.strictEqual(state.listenerCount('change:user.name'), 0);
  });

  test('the closure returned by subscribe() removes the listener', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    let calls = 0;
    const dispose = state.subscribe('user.name', () => { calls++; });
    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(calls, 1);
    dispose();
    state.update({ user: { name: 'Carol' } });
    assert.strictEqual(calls, 1, 'listener fired after its returned unsubscribe closure ran');
    assert.strictEqual(state.listenerCount('change:user.name'), 0, 'listener still registered after unsubscribe closure');
  });

  test('the closure returned by subscribe("*") removes the stateChange listener', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    let calls = 0;
    const dispose = state.subscribe('*', () => { calls++; });
    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(calls, 1);
    dispose();
    state.update({ user: { name: 'Carol' } });
    assert.strictEqual(calls, 1, 'wildcard listener fired after unsubscribe closure ran');
    assert.strictEqual(state.listenerCount('stateChange'), 0);
  });

  test('repeated subscribe/dispose cycles do not accumulate listeners (React-cleanup pattern)', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    let calls = 0;
    for (let i = 0; i < 5; i++) {
      const dispose = state.subscribe('user.age', () => { calls++; });
      dispose();
    }
    assert.strictEqual(state.listenerCount('change:user.age'), 0, `leaked ${state.listenerCount('change:user.age')} listeners over 5 mount/unmount cycles`);
    state.update({ user: { age: 31 } });
    assert.strictEqual(calls, 0, 'disposed listeners still notified');
  });
});
