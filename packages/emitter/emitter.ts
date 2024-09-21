import { EventEmitter } from 'eventemitter3';
type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: DeepPartial<T[P]>;
} : T;

export class StateEmitter<T extends object> extends EventEmitter {
  private state: T;

  constructor(initialState: T) {
    super();
    this.state = { ...initialState };
  }

  subscribe(path: string, listener: (newValue: any, oldValue?: any) => void): void {
    if (path === '*') {
      this.on('stateChange', listener);
    } else {
      this.on(`change:${path}`, listener);
    }
  }

  update(partialState: DeepPartial<T>): void {
    const oldState = { ...this.state };
    try {
      this.state = deepMerge(this.state, partialState);
    } catch (error) {
      if (error instanceof TypeError && error.message === 'Circular reference detected') {
        throw new TypeError('Cannot update with circular reference');
      }
      throw error;
    }

    this.emitChanges(oldState);
  }

  set(newState: T): void {
    if (!isObject(newState)) {
      throw new TypeError('newState must be an object');
    }
    const oldState = this.state;
    this.state = { ...newState };

    this.emitChanges(oldState);
  }

  get(path: string): any {
    if (path === '*') {
      return { ...this.state };
    }
    return getNestedValue(this.state, path);
  }

  private emitChanges(oldState: T): void {
    const changedPaths = this.getChangedPaths(oldState, this.state);

    for (const path of changedPaths) {
      const newValue = this.get(path);
      const oldValue = getNestedValue(oldState, path);
      this.emit(`change:${path}`, newValue, oldValue);
    }

    this.emit('stateChange', this.state, oldState);
  }

  private getChangedPaths(oldObj: any, newObj: any, currentPath: string = ''): string[] {
    const paths: string[] = [];

    for (const key in newObj) {
      const newValue = newObj[key];
      const oldValue = oldObj[key];
      const path = currentPath ? `${currentPath}.${key}` : key;

      if (isObject(newValue) && isObject(oldValue)) {
        paths.push(...this.getChangedPaths(oldValue, newValue, path));
      } else if (newValue !== oldValue) {
        paths.push(path);
      }
    }

    return paths;
  }
}

// Utility functions (updated)
function getNestedValue(obj: any, path: string): any {
  const keys = path.split('.');
  let result = obj;

  for (const key of keys) {
    if (result === null || result === undefined) {
      return undefined;
    }
    result = result[key];
  }

  return result;
}

function deepMerge(target: any, source: any, seen = new WeakSet()): any {
  if (!isObject(source)) {
    return source;
  }

  if (seen.has(source)) {
    throw new TypeError('Circular reference detected');
  }
  seen.add(source);

  const output = isObject(target) ? { ...target } : {};

  for (const key in source) {
    output[key] = deepMerge(target && target[key], source[key], seen);
  }

  seen.delete(source);
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}
