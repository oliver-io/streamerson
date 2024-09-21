import test from 'node:test';
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

interface SomeUserRecord {
  user: { name: string, age: number },
  isLoggedIn?: boolean
}

test('StateEmitter Happy Path Tests', async (t) => {
  await t.test('constructor initializes with given state', () => {
    const initialState = { user: { name: 'Alice', age: 30 }, isLoggedIn: false };
    const state = new StateEmitter<SomeUserRecord>(initialState);
    assert.deepStrictEqual(state.get('*'), initialState);
  });

  await t.test('get retrieves nested values correctly', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    assert.strictEqual(state.get('user.name'), 'Alice');
    assert.strictEqual(state.get('user.age'), 30);
  });

  await t.test('update partially updates state', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 }, isLoggedIn: false });
    state.update({ user: { name: 'Bob' } });
    assert.deepStrictEqual(state.get('*'), { user: { name: 'Bob', age: 30 }, isLoggedIn: false });
  });

  await t.test('set replaces entire state', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 }, isLoggedIn: false });
    state.set({ user: { name: 'Charlie', age: 25 }, isLoggedIn: true });
    assert.deepStrictEqual(state.get('*'), { user: { name: 'Charlie', age: 25 }, isLoggedIn: true });
  });

  await t.test('subscribe to specific path notifies of changes', async () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 } });
    let notified = false;

    state.subscribe('user.name', (newValue, oldValue) => {
      assert.strictEqual(newValue, 'Bob');
      assert.strictEqual(oldValue, 'Alice');
      notified = true;
    });

    state.update({ user: { name: 'Bob' } });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, true);
  });

  await t.test('subscribe to root path notifies of changes', async () => {
    const state = new StateEmitter<SomeUserRecord>({
      user: { name: 'Alice', age: 30 },
      isLoggedIn: false
    });
    let notified = false;

    state.subscribe('*', (newState) => {
      assert.deepStrictEqual(newState, { user: { name: 'Alice', age: 30 }, isLoggedIn: true });
      notified = true;
    });

    state.update({ isLoggedIn: true });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, true);
  });

  await t.test('multiple subscriptions are notified', async () => {
    const state = new StateEmitter<{
      user: { name: string, age: number },
      isLoggedIn: boolean
    }>({
      user: { name: 'Alice', age: 30 },
      isLoggedIn: false
    });

    let count = 0;

    state.subscribe('user.name', () => {
      count++;
    });

    state.subscribe('*', () => {
      count++;
    });

    state.update({ user: { name: 'Bob' } });

    // Wait for the next event loop to ensure all callbacks have been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(count, 2);
  });

  await t.test('unsubscribe removes listener', async () => {
    const state = new StateEmitter({ value: 0 });
    let callCount = 0;

    const listener = () => {
      callCount++;
    };

    state.subscribe('value', listener);
    state.update({ value: 1 });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(callCount, 1);

    state.off('change:value', listener);
    state.update({ value: 2 });

    // Wait for the next event loop to ensure all callbacks have been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(callCount, 1);
  });

  await t.test('subscribe to a key before it exists', async () => {
    const state = new StateEmitter<{
      existingKey: string,
      newKey?: string
    }>({ existingKey: 'value' });
    let notified = false;
    let newValue;

    state.subscribe('newKey', (value) => {
      notified = true;
      newValue = value;
    });

    state.update({ newKey: 'new value' });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(notified, true, 'Subscriber should be notified');
    assert.strictEqual(newValue, 'new value', 'Subscriber should receive the new value');
    assert.strictEqual(state.get('newKey'), 'new value', 'New key should be added to the state');
  });
});
