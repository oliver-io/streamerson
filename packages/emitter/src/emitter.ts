import { EventEmitter } from 'eventemitter3';
import get from 'lodash.get';

type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: DeepPartial<T[P] | null>;
} : T;

type Listener = (newValue: any, oldValue?: any) => void;

export class StateEmitter<T extends object> extends EventEmitter {
  private state: T;

  constructor(initialState: T | string) {
    super();
    try {
      this.state = this.valueFromUpdate(initialState);
    } catch (err: any) {
      throw new TypeError(`Unserializable initial state: ${err?.message ?? 'unknown error'}`);
    }
  }

  private valueFromUpdate(obj: T | DeepPartial<T> | string) {
    const value = JSON.parse(typeof obj === 'string' ?
      obj :
      JSON.stringify(obj)
    ) as unknown as T;

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Type \`${
        typeof value !== 'object' ?
          typeof value : 'array'
      }\` is not serializable to a StateEmitter value`);
    }

    return value;
  }

  private isPathChanged(path: string, newState: any, oldState: any): boolean {
    const newValue = this.getNestedValue(newState, path);
    const oldValue = this.getNestedValue(oldState, path);
    return !Object.is(newValue, oldValue);
  }

  public subscribe(path: string, listener: Listener, options?: { exclude?: Array<string> }): ()=>void {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    const { exclude } = options ?? {}
    const wrappedListener = (newValue: any, oldValue: any) => {
      if (exclude && exclude.length > 0) {
        const changedPaths = this.getChangedPaths(oldValue, newValue);
        const shouldNotify = changedPaths.some(changedPath => {
          const fullPath = path === '*' ? changedPath : `${path}.${changedPath}`;
          return !exclude.some(excludePath => this.matchesExcludePath(fullPath, excludePath));
        });

        if (!shouldNotify) {
          return;
        }
      }

      listener(newValue, oldValue);
    };

    // Store the original listener as a property of the wrapped listener
    (wrappedListener as any).originalListener = listener;

    if (path === '*') {
      this.on('stateChange', wrappedListener);
    } else {
      this.on(`change:${path}`, wrappedListener);
    }

    return () => this.unsubscribe(path, wrappedListener)
  }

  private matchesExcludePath(path: string, excludePath: string): boolean {
    const pathParts = path.split('.');
    const excludeParts = excludePath.split('.');

    let pathIndex = 0;
    let excludeIndex = 0;

    while (excludeIndex < excludeParts.length && pathIndex < pathParts.length) {
      const excludePart = excludeParts[excludeIndex];
      const pathPart = pathParts[pathIndex];

      if (excludePart === '*') {
        // If '*' is the last part in excludePath, it matches the rest of path
        if (excludeIndex === excludeParts.length - 1) {
          return true;
        }
        // Move to the next part in excludePath and find a matching pathPart
        excludeIndex++;
        const nextExcludePart = excludeParts[excludeIndex];

        while (pathIndex < pathParts.length && pathParts[pathIndex] !== nextExcludePart) {
          pathIndex++;
        }

        if (pathIndex === pathParts.length) {
          return false;
        }
      } else {
        if (excludePart !== pathPart) {
          return false;
        }
        pathIndex++;
        excludeIndex++;
      }
    }

    // If we've consumed all excludeParts, it's a match
    return excludeIndex === excludeParts.length;
  }

  private getChangedPaths(oldObj: any, newObj: any, currentPath: string = ''): string[] {
    const paths: string[] = [];

    if (!this.isObject(oldObj) || !this.isObject(newObj)) {
      if (!Object.is(oldObj, newObj)) {
        paths.push(currentPath);
      }
      return paths;
    }

    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
      const newValue = newObj[key];
      const oldValue = oldObj[key];
      const newPath = currentPath ? `${currentPath}.${key}` : key;

      if (this.isObject(newValue) && this.isObject(oldValue)) {
        paths.push(...this.getChangedPaths(oldValue, newValue, newPath));
      } else if (!Object.is(newValue, oldValue)) {
        paths.push(newPath);
      }
    }

    return paths;
  }

  unsubscribe(path: string, listener: Listener): void {
    const eventName = path === '*' ? 'stateChange' : `change:${path}`;
    const listeners = this.listeners(eventName);

    for (const l of listeners) {
      if ((l as any).originalListener === listener) {
        this.off(eventName, l);
        break;
      }
    }
  }

  update(_partialState: DeepPartial<T> | string, options: {
    merge: boolean
  } = { merge: true }): void {
    const partialState = this.valueFromUpdate(_partialState);
    const oldState = { ...this.state };
    if(options?.merge) {
      this.state = this.deepMerge(this.state, partialState)
    } else {
      Object.assign(this.state, partialState)
    }
    this.emitChanges(oldState);
  }

  set(newState: T): void {
    if (!this.isObject(newState)) {
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
    return this.getNestedValue(this.state, path);
  }

  private getNestedValue(obj: any, path: string): any {
    return get(obj, path) ?? undefined;
  }

  private emitChanges(oldState: T): void {
    const changedPaths = this.getChangedPaths(oldState, this.state);
    const allChangedPaths = this.getAllAffectedPaths(changedPaths);

    for (const path of allChangedPaths) {
      const newValue = this.get(path);
      const oldValue = this.getNestedValue(oldState, path);
      this.emit(`change:${path}`, newValue, oldValue);

      // Emit wildcard events for parent paths
      const parts = path.split(/\.|\[|\]/).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const wildcardPath = parts.slice(0, i).concat('*').join('.');
        this.emit(`change:${wildcardPath}`, newValue, oldValue);
      }

      // Handle array element changes
      if (Array.isArray(newValue)) {
        newValue.forEach((_, index) => {
          const arrayElementPath = `${path}[${index}]`;
          const arrayElementValue = this.get(arrayElementPath);
          const oldArrayElementValue = this.getNestedValue(oldState, arrayElementPath);

          if (!Object.is(arrayElementValue, oldArrayElementValue)) {
            this.emit(`change:${arrayElementPath}`, arrayElementValue, oldArrayElementValue);
            this.emit(`change:${path}.*`, arrayElementValue, oldArrayElementValue);
            this.emit(`change:${path}[*]`, arrayElementValue, oldArrayElementValue);
          }

          // Emit changes for nested properties in array elements
          if (this.isObject(arrayElementValue)) {
            Object.keys(arrayElementValue).forEach(key => {
              const nestedPath = `${arrayElementPath}.${key}`;
              const nestedValue = this.get(nestedPath);
              const oldNestedValue = this.getNestedValue(oldState, nestedPath);

              if (!Object.is(nestedValue, oldNestedValue)) {
                this.emit(`change:${nestedPath}`, nestedValue, oldNestedValue);
              }
            });
          }
        });
      }
    }

    if (allChangedPaths.length > 0) {
      this.emit('stateChange', this.state, oldState);
    }
  }

  private getAllAffectedPaths(changedPaths: string[]): string[] {
    const allPaths = new Set<string>();

    for (const path of changedPaths) {
      const parts = path.split('.');
      let currentPath = '';
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}.${part}` : part;
        allPaths.add(currentPath);
      }
    }

    return Array.from(allPaths);
  }

  private deepMerge(target: any, source: any): any {
    if (source === 'null') {
      return undefined;
    }

    if (Array.isArray(source)) {
      return [...source];
    }

    if (!this.isObject(target) || !this.isObject(source)) {
      return source;
    }

    const output = { ...target };

    for (const key in source) {
      if (source[key] === 'null') {
        source[key] = undefined;
      }
      if (this.isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = this.deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    }

    return output;
  }

  private isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
}
