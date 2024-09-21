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

// Update the state
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
new ObservableObject<T>(initialState: T)
```

- `initialState`: The initial state object.

#### Methods

| Method | Description |
|--------|-------------|
| `subscribe(path: string, listener: (newValue: any, oldValue?: any) => void): void` | Subscribes to changes at a specific path. |
| `update(partialState: Partial<T>): void` | Partially updates the state object. |
| `set(newState: T): void` | Replaces the entire state object. |
| `get(path: string): any` | Retrieves the value at the specified path. |

#### EventEmitter Methods

`ObservableObject` extends `EventEmitter` from `eventemitter3`, providing these additional methods:

| Method | Description |
|--------|-------------|
| `on(event: string \| symbol, listener: Function): this` | Adds a listener for the event. |
| `off(event: string \| symbol, listener: Function): this` | Removes a listener for the event. |
| `once(event: string \| symbol, listener: Function): this` | Adds a one-time listener for the event. |
| `emit(event: string \| symbol, ...args: any[]): boolean` | Triggers all listeners for the specified event. |

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

## 🤝 Contributing

Contributions are welcome and appreciated! Here's how you can contribute:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

Please ensure your code adheres to the existing style and all tests pass before submitting a PR.

## 🙏 Acknowledgements

- [eventemitter3](https://github.com/primus/eventemitter3) for providing the high-performance event emitter.
- All the contributors who have helped shape and improve this project.
