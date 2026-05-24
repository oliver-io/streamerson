/**
 * Config validation. The one place TESTING.md §1 sanctions a unit test — "highly
 * variadic and complicated" validation logic — so this is a pure unit test (no Redis)
 * exercising every reject branch of `validateOptions` (via the public
 * `createConsumerGroupConfig`) and the documented defaults.
 *
 * Run: bun test packages/consumer/test/config.test.ts
 */
import { test, expect, describe } from 'bun:test';
import { createConsumerGroupConfig } from '../src/config';

describe('createConsumerGroupConfig — defaults & passthrough', () => {
  test('applies documented defaults when only name is given', () => {
    const cfg = createConsumerGroupConfig({ name: 'g' });
    expect(cfg.name).toBe('g');
    expect(cfg.count).toBe(1);
    expect(cfg.processingTimeout).toBe(0);
    expect(cfg.idleTimeout).toBe(0);
    expect(cfg.blockTimeout).toBe(100);
    expect(cfg.prefetch).toBe(1);
    expect(cfg.retry).toBeUndefined();
  });

  test('passes through valid explicit values (incl. count 0 and retry)', () => {
    const cfg = createConsumerGroupConfig({ name: 'g', count: 0, processingTimeout: 500, idleTimeout: 250, blockTimeout: 50, prefetch: 4, retry: { maxAttempts: 3 } });
    expect(cfg.count).toBe(0);
    expect(cfg.processingTimeout).toBe(500);
    expect(cfg.idleTimeout).toBe(250);
    expect(cfg.blockTimeout).toBe(50);
    expect(cfg.prefetch).toBe(4);
    expect(cfg.retry).toEqual({ maxAttempts: 3 });
  });
});

describe('createConsumerGroupConfig — rejects invalid options', () => {
  test('count: negative or non-integer', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', count: -1 })).toThrow('count must be a non-negative integer');
    expect(() => createConsumerGroupConfig({ name: 'g', count: 1.5 })).toThrow('count must be a non-negative integer');
  });

  test('processingTimeout / idleTimeout: negative', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', processingTimeout: -1 })).toThrow('must be >= 0');
    expect(() => createConsumerGroupConfig({ name: 'g', idleTimeout: -1 })).toThrow('must be >= 0');
  });

  test('blockTimeout: negative', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', blockTimeout: -1 })).toThrow('blockTimeout must be >= 0');
  });

  test('prefetch: below 1 or non-integer', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', prefetch: 0 })).toThrow('prefetch must be an integer >= 1');
    expect(() => createConsumerGroupConfig({ name: 'g', prefetch: 2.5 })).toThrow('prefetch must be an integer >= 1');
  });

  test('retry.maxAttempts: below 1 or non-integer', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', processingTimeout: 100, retry: { maxAttempts: 0 } })).toThrow('retry.maxAttempts must be an integer >= 1');
    expect(() => createConsumerGroupConfig({ name: 'g', processingTimeout: 100, retry: { maxAttempts: 1.5 } })).toThrow('retry.maxAttempts must be an integer >= 1');
  });

  test('retry requires processingTimeout > 0 (the reclaim idle threshold, CG-I7)', () => {
    expect(() => createConsumerGroupConfig({ name: 'g', retry: { maxAttempts: 2 } })).toThrow('retry requires processingTimeout > 0');
    expect(() => createConsumerGroupConfig({ name: 'g', processingTimeout: 0, retry: { maxAttempts: 2 } })).toThrow('retry requires processingTimeout > 0');
  });
});
