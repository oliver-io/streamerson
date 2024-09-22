import test from 'node:test';
import assert from 'node:assert/strict';
import { StateEmitter } from '../emitter';

test('Complex Traversal Cases', async (t) => {
  await t.test('handles expected deep dictionary diffing', async () => {
    const state = new StateEmitter<{
      record: Record<string, Record<string, string>>,
      newKey?: string
    }>({
      record: {
        abcd: {
          id: 'some-id'
        },
        efgh: {
          id: 'another-id'
        }
      }
    });

    let notified = false;

    state.subscribe('record', (value) => {
      notified = true;
    });

    state.update({
      record: {
        abcd: {
          newKey: 'new value'
        }
      }
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(state.get('record.abcd.newKey'), 'new value', 'New key should be added to the state');
    assert.strictEqual(state.get('record.abcd.id'), 'some-id', 'Existing keys should not be erased');
    assert.strictEqual(state.get('record.efgh.id'), 'another-id', 'Other object should not be affected');
    assert.strictEqual(notified, true, 'Subscriber should be notified');
  });

  await t.test('emits for wildcard record subscription', async () => {
    const state = new StateEmitter<{
      record: Record<string, Record<string, string>>,
      newKey?: string
    }>({
      record: {
        abcd: {
          id: 'some-id'
        },
        efgh: {
          id: 'another-id'
        }
      }
    });

    let notified = 0;

    state.subscribe('record.*', (value) => {
      notified++;
    });

    state.update({
      record: {
        abcd: {
          newKey: 'new value'
        },
        efgh: {
          anotherKey: 'another value'
        }
      }
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, 4, 'Subscriber should be notified four times');
  });

  await t.test('emits for index record subscription', async () => {
    const state = new StateEmitter<{
      record: Record<string, Record<string, string>>,
      newKey?: string
    }>({
      record: {
        abcd: {
          id: 'some-id'
        },
        efgh: {
          id: 'another-id'
        }
      }
    });

    let notified = 0;

    state.subscribe('record.abcd', (value) => {
      notified++;
    });

    state.update({
      record: {
        abcd: {
          newKey: 'new value'
        },
        efgh: {
          anotherKey: 'another value'
        }
      }
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, 1, 'Subscriber should be notified once');
  });


  await t.test('emits for deep index record subscription', async () => {
    const state = new StateEmitter<{
      record: Record<string, Record<string, string>>,
      newKey?: string
    }>({
      record: {
        abcd: {
          id: 'some-id'
        },
        efgh: {
          id: 'another-id'
        }
      }
    });

    let notified = 0;
    let value = ''

    state.subscribe('record.abcd.newKey', (v) => {
      notified++;
      value = v
    });

    state.update({
      record: {
        abcd: {
          newKey: 'new value'
        },
        efgh: {
          anotherKey: 'another value'
        }
      }
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, 1, 'Subscriber should be notified once');
    assert.strictEqual(value, 'new value', 'Emitted value does not match');
  });


  await t.test('emits for array element wildcard subscription', async () => {
    const state = new StateEmitter<{
      record: Array<Record<string, string>>,
      newKey?: string
    }>({
      record: [
        {
          id: 'some-id'
        },
        {
          id: 'another-id'
        }
      ]
    });

    let notified = 0;

    state.subscribe('record.*', (value) => {
      notified++;
    });

    state.update({
      record: [
        {
          newKey: 'new value'
        },
        {
          anotherKey: 'another value'
        }
      ]
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, 2, 'Subscriber should be notified twice');
  });

  await t.test('emits for deep array element index subscription', async () => {
    const state = new StateEmitter<{
      record: Array<Record<string, string>>,
      newKey?: string
    }>({
      record: [
        {
          id: 'some-id'
        },
        {
          id: 'another-id'
        }
      ]
    });

    let notified = 0;
    let value = ''

    state.subscribe('record[1].anotherKey', (v) => {
      notified++;
      value = v
    });

    state.update({
      record: [
        {
          newKey: 'new value'
        },
        {
          anotherKey: 'another value'
        }
      ]
    });

    // Wait for the next event loop to ensure the callback has been called
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(notified, 1, 'Subscriber should be notified once');
    assert.strictEqual(value, 'another value', 'Emitted value does not match');
  });
});
