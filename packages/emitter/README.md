# 🔭 ObservableObject

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-4.5%2B-blue)

A TypeScript library that provides an observable state object with event-based subscriptions to changes at any nested path within the object, using [`eventemitter3`](https://github.com/primus/eventemitter3).

## 🌟 Features

- **🔍 Deep Subscription**: Subscribe to changes on any lodash-like path within your state object.
- **🔄 Partial and Full Updates**: Update the state object entirely or partially with ease.
- **🪶 Lightweight**: Built with minimal dependencies for efficient performance.
- **📘 TypeScript Support**: Fully typed for better developer experience.
- **🚀 High Performance**: Leverages `eventemitter3` for fast event handling.

## 📦 Installation

Install the package via npm:

```bash
npm install @streamerson/emitter
```

Or using yarn:

```bash
yarn add @streamerson/emitter
```

## 🚀 Quick Start

```typescript
import { ObservableObject } from '@streamerson/emitter';

// Create an observable object
const state = new ObservableObject({
  user: { name: 'Alice', age: 30 },
  isLoggedIn: false
});

// Subscribe to changes
state.subscribe('user.name', (newValue, oldValue) => {
  console.log(`Name changed: ${oldValue} -> ${newValue}`);
});

// Update the state via JSON Text
state.update('{ "user": { "name": "Bob" } }');

// Update the state via JSON:
state.update({ user: { name: 'Bob' } });
```

## 📘 Usage Guide

### Importing the Module

```typescript
import { ObservableObject } from '@streamerson/emitter';
```

### Creating an Observable Object

Initialize your state with any nested structure of primitives, arrays, or dictionaries:

```typescript
const state = new ObservableObject({
  user: {
    name: 'Alice',
    age: 30,
    hobbies: ['reading', 'hiking']
  },
  settings: {
    theme: 'dark',
    notifications: true
  },
  isLoggedIn: false
});
```

### Text versus JSON API

The update methods accept text and JSON. Text is probably the more blessed path because:

- It guarantees no circularity errors, which will be thrown on objects with circular references
- To guarantee the above, we text-serialize and reparse all incoming objects.
  - This has negative performance implications for large objects, so updating from text is safer
  - This lets you avoid serializing messages if they are safe to merge into client states

### Subscribing to Changes

Subscribe to changes on any path using lodash-like syntax:

```typescript
// Subscribe to changes on 'user.name'
state.subscribe('user.name', (newValue, oldValue) => {
  console.log(`User name changed from ${oldValue} to ${newValue}`);
});

// Subscribe to changes in the entire user object
state.subscribe('user', (newUser, oldUser) => {
  console.log('User object changed:', newUser);
});

// Subscribe to changes in an array
state.subscribe('user.hobbies', (newHobbies, oldHobbies) => {
  console.log('Hobbies updated:', newHobbies);
});

// Subscribe to any change in the state
state.subscribe('*', (newState) => {
  console.log('State changed:', newState);
});


// Subscribe to some change in the state, with exclusions
state.subscribe('*', (newState) => {
  console.log('State changed:', newState);
}, { exclude: ['some.path'] });
```

### Updating the State

You can update the state partially or entirely:

```typescript
// Partial update
state.update({
  user: {
    name: 'Bob',
    hobbies: [...state.get('user.hobbies'), 'swimming']
  }
});

// Full update
state.set({
  user: {
    name: 'Charlie',
    age: 25,
    hobbies: ['coding']
  },
  settings: {
    theme: 'light',
    notifications: false
  },
  isLoggedIn: true
});
```

## Deleting the state:

To delete records from the state, you should use `null`, not undefined. Namely, this is because not all platforms handle the serialization of `undefined` the same and many will strip it from the JSON of a sent record.

If you send `undefined`, for compatibility, we will entirely ignore it.  `null` however will remove the object from the tracked state.

```typescript
state.update({ abc: 123 })
state.update({ abc: undefined })
state.get('abc') === 123 // true
state.update({ abc: null })
state.get('abc') === undefined // true
```

### Retrieving State Values

Use the `get` method to retrieve values from the state:

```typescript
const userName = state.get('user.name');
console.log('Current user name:', userName);

const userHobbies = state.get('user.hobbies');
console.log('User hobbies:', userHobbies);
```

## 🛠 API Reference

### ObservableObject<T>

#### Constructor

```typescript
new ObservableObject<T>(initialState
:
T
)
```

- `initialState`: The initial state object.

#### Methods

| Method                                                                             | Description                                |
|------------------------------------------------------------------------------------|--------------------------------------------|
| `subscribe(path: string, listener: (newValue: any, oldValue?: any) => void): void` | Subscribes to changes at a specific path.  |
| `update(partialState: Partial<T>): void`                                           | Partially updates the state object.        |
| `set(newState: T): void`                                                           | Replaces the entire state object.          |
| `get(path: string): any`                                                           | Retrieves the value at the specified path. |

#### EventEmitter Methods

`ObservableObject` extends `EventEmitter` from `eventemitter3`, providing these additional methods:

| Method                                                    | Description                                     |
|-----------------------------------------------------------|-------------------------------------------------|
| `on(event: string \| symbol, listener: Function): this`   | Adds a listener for the event.                  |
| `off(event: string \| symbol, listener: Function): this`  | Removes a listener for the event.               |
| `once(event: string \| symbol, listener: Function): this` | Adds a one-time listener for the event.         |
| `emit(event: string \| symbol, ...args: any[]): boolean`  | Triggers all listeners for the specified event. |

## 🧪 Testing

The library is tested using Node.js native testing modules (`node:test`). To run the tests:

```bash
npm run test
```

Or, if you prefer to run specific test files:

```bash
tsx --test ./tests/emitter.happy.test.ts
tsx --test ./tests/emitter.sad.test.ts
```

## TODO: 
- I'd like to get AJV (or the like) in as a schematized option for verified state data
- Needs some more tests
- Other Stuff

## 🤝 Contributing

Contributions are welcome and appreciated! Here's how you can contribute:

1. Fork & PR

Please ensure your code adheres to the existing style and all tests pass before submitting a PR.

## 🙏 Acknowledgements

- [eventemitter3](https://github.com/primus/eventemitter3)
- [My Cat, Curie](../../docs/images/curie.jpg)
- [My Cat, Anastasia](../../docs/images/anastasia.jpg)
