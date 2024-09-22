# 🔭 StateEmitter

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-4.5%2B-blue)

A TypeScript library that provides a state management system with event-based subscriptions to changes at any nested path within the state object, using [`eventemitter3`](https://github.com/primus/eventemitter3).

## 🌟 Features

- **🔍 Deep Subscription**: Subscribe to changes on any lodash-like path within your state object.
- **🔄 Partial and Full Updates**: Update the state object entirely or partially with ease.
- **🪶 Lightweight**: Built with minimal dependencies for efficient performance.
- **📘 TypeScript Support**: Fully typed for better developer experience.
- **🚀 High Performance**: Leverages `eventemitter3` for fast event handling.
- **🔒 Type Safety**: Ensures type safety for your state object.
- **🎯 Path Exclusion**: Ability to exclude specific paths from notifications.
- **🔀 Merge Options**: Choose between merging or replacing state during updates.

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
import { StateEmitter } from '@streamerson/emitter';

// Create a state emitter
const state = new StateEmitter({
  user: { name: 'Alice', age: 30 },
  isLoggedIn: false
});

// Subscribe to changes
state.subscribe('user.name', (newValue, oldValue) => {
  console.log(`Name changed: ${oldValue} -> ${newValue}`);
});

// Update the state via JSON Text
state.update('{ "user": { "name": "Bob" } }');

// Update the state via object
state.update({ user: { name: 'Charlie' } });
```

# 🔭 StateEmitter

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-4.5%2B-blue)

A TypeScript library that provides a state management system with event-based subscriptions to changes at any nested path within the state object, using [`eventemitter3`](https://github.com/primus/eventemitter3).

## 🤔 Why?

StateEmitter allows you to create a powerful, flexible state management system that can be easily integrated into your applications. Here's a real-world example from a game that demonstrates how StateEmitter can be used to subscribe to state changes in a local global state:

```typescript
import {useGameStateEmitterContext} from "../context/gameStateContext";
import {RoomId, RoomStaticData} from "@rpgpt/shared";
import React from "react";
import {GameState} from "../client";

export type RoomEntityData = GameState['room']['objects']
export function useRoomObjects(): RoomEntityData {
    const emitter = useGameStateEmitterContext()
    const [roomObjects, setRoomObjects] = React.useState<RoomEntityData>({})

    React.useEffect(() => {
        return emitter.subscribe('room.objects', setRoomObjects)
    })

    return roomObjects
}
```

In this example, we're using StateEmitter in a game context. The `useRoomObjects` hook subscribes to changes in the `room.objects` path of the game state. Whenever the room objects change, the hook automatically updates its state, allowing React components to re-render with the latest data. This demonstrates how StateEmitter can provide a clean and efficient way to manage and react to state changes in complex applications like games.

## 📘 Usage Guide

### Importing the Module

```typescript
import { StateEmitter } from '@streamerson/emitter';
```

### Creating a StateEmitter

Initialize your state with any nested structure of primitives, arrays, or objects:

```typescript
const state = new StateEmitter({
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
const unsubscribe = state.subscribe('user.name', (newValue, oldValue) => {
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
state.subscribe('*', (newState, oldState) => {
  console.log('State changed:', newState);
});

// Subscribe to changes in the state, excluding specific paths
state.subscribe('*', (newState, oldState) => {
  console.log('State changed (excluding user.age):', newState);
}, { exclude: ['user.age'] });

// Unsubscribe when no longer needed
unsubscribe();
```

### Updating the State

You can update the state partially or entirely:

```typescript
// Partial update (merges by default)
state.update({
  user: {
    name: 'Bob',
    hobbies: [...state.get('user.hobbies'), 'swimming']
  }
});

// Partial update with replace option
state.update({ user: { name: 'David' } }, { merge: false });

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

// Update via JSON string
state.update('{"user": {"name": "Eve"}}');
```

### Deleting State Properties

To delete properties from the state, use `null`:

```typescript
state.update({ user: { age: null } });
// The 'age' property will be removed from the user object
```

### Retrieving State Values

Use the `get` method to retrieve values from the state:

```typescript
const userName = state.get('user.name');
console.log('Current user name:', userName);

const userHobbies = state.get('user.hobbies');
console.log('User hobbies:', userHobbies);

// Get the entire state
const entireState = state.get('*');
console.log('Entire state:', entireState);
```

## 🛠 API Reference

### StateEmitter<T>

#### Constructor

```typescript
new StateEmitter<T>(initialState: T | string)
```

- `initialState`: The initial state object or a JSON string representation of the state.

#### Methods

| Method | Description |
|--------|-------------|
| `subscribe(path: string, listener: (newValue: any, oldValue?: any) => void, options?: { exclude?: string[] }): () => void` | Subscribes to changes at a specific path. Returns an unsubscribe function. |
| `unsubscribe(path: string, listener: (newValue: any, oldValue?: any) => void): void` | Unsubscribes a specific listener from a path. |
| `update(partialState: DeepPartial<T> \| string, options?: { merge: boolean }): void` | Updates the state object. Accepts partial state or JSON string. |
| `set(newState: T): void` | Replaces the entire state object. |
| `get(path: string): any` | Retrieves the value at the specified path. |

#### EventEmitter Methods

`StateEmitter` extends `EventEmitter` from `eventemitter3`, providing these additional methods:

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

## 🚧 TODO

- Implement schema validation using AJV or similar for verified state data
- Expand test coverage
- Performance optimizations for large state objects
- Add support for computed properties

## 🤝 Contributing

Contributions are welcome and appreciated! Here's how you can contribute:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

Please ensure your code adheres to the existing style and all tests pass before submitting a PR.

## 🙏 Acknowledgements

- [eventemitter3](https://github.com/primus/eventemitter3)
- [lodash.get](https://lodash.com/docs/4.17.15#get)
- All contributors and users of this library

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
