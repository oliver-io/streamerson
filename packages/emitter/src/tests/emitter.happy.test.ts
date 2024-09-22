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

  await t.test('update with string API updates state correctly', () => {
    const state = new StateEmitter<SomeUserRecord>({ user: { name: 'Alice', age: 30 }, isLoggedIn: false });
    state.update('{"user": {"name": "Charlie"}, "isLoggedIn": true}');
    assert.deepStrictEqual(state.get('*'), { user: { name: 'Charlie', age: 30 }, isLoggedIn: true });
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

  await t.test('array state functions as expected', () => {
    const state = new StateEmitter<{ list: Array<number> }>({
      list: [3, 4, 5]
    });

    state.set({ list: [3, 4] });
    assert.deepStrictEqual(state.get('*'), { list: [3, 4] });
  });

  await t.test('null deletes values', () => {
    const state = new StateEmitter({ value: 'initial' });
    state.update({ value: null });
    assert.strictEqual(state.get('value'), undefined);
  });

  await t.test('the string null deletes values', () => {
    const state = new StateEmitter({ value: 'initial' });
    state.update({ value: 'null' });
    assert.strictEqual(state.get('value'), undefined);
  });

  await t.test('no event on a functional non-change', async () => {
    const initialStateJsonString = JSON.stringify({ user: { name: 'Alice', age: 30 }, isLoggedIn: false });
    let notified = false;
    const state = new StateEmitter<SomeUserRecord>(
      JSON.parse(initialStateJsonString)
    );

    state.subscribe('*', () => {
      notified = true;
      throw new Error('We should not receive this inside this test');
    });

    state.set(JSON.parse(initialStateJsonString));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, false);
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

    state.unsubscribe('value', listener);
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

  await t.test('exclude single path', async (t) => {
    const state = new StateEmitter({ user: { name: 'Alice', age: 30 } });
    let callCount = 0;

    state.subscribe('user', () => {
      callCount++;
    }, {exclude: ['user.*.age']});

    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(callCount, 1, 'Listener should be called for name change');

    state.update({ user: { age: 31 } });
    assert.strictEqual(callCount, 1, 'Listener should not be called for age change');
  });

  await t.test('exclude multiple paths', async (t) => {
    const state = new StateEmitter({
      user: { name: 'Alice', age: 30, address: { city: 'New York', country: 'USA' } }
    });
    let callCount = 0;

    state.subscribe('user', () => {
      callCount++;
    }, { exclude: ['user.*.age', 'user.*.address.country']});

    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(callCount, 1, 'Listener should be called for name change');

    state.update({ user: { age: 31 } });
    assert.strictEqual(callCount, 1, 'Listener should not be called for age change');

    state.update({ user: { address: { city: 'Los Angeles' } } });
    assert.strictEqual(callCount, 2, 'Listener should be called for city change');

    state.update({ user: { address: { country: 'Canada' } } });
    assert.strictEqual(callCount, 2, 'Listener should not be called for country change');
  });

  await t.test('exclude with wildcard subscription', async (t) => {
    const state = new StateEmitter({
      user: { name: 'Alice', age: 30 },
      settings: { theme: 'dark', notifications: true }
    });
    let callCount = 0;

    state.subscribe('*', () => {
      callCount++;
    }, { exclude: ['user.*.age', 'settings.notifications'] });

    state.update({ user: { name: 'Bob' } });
    assert.strictEqual(callCount, 1, 'Listener should be called for user name change');

    state.update({ user: { age: 31 } });
    assert.strictEqual(callCount, 1, 'Listener should not be called for user age change');

    state.update({ settings: { theme: 'light' } });
    assert.strictEqual(callCount, 2, 'Listener should be called for settings theme change');

    state.update({ settings: { notifications: false } });
    assert.strictEqual(callCount, 2, 'Listener should not be called for settings notifications change');
  });
});
