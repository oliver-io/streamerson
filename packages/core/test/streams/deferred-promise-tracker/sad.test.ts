import { describe, test } from 'bun:test';
import * as assert from 'node:assert';
import { DeferralTracker } from '../../../src';
import { mockLogger as logger } from '@streamerson/test-utils';

describe('the deferral tracker times out', () => {
  test('a pending promise rejects when its id is never heard within the timeout', async () => {
    const tracker = new DeferralTracker({ timeout: 50, logger });
    await assert.rejects(tracker.promise('never-arrives'));
    tracker.cancelAll();
  });

  test('a custom timeout is honored', async () => {
    const tracker = new DeferralTracker({ timeout: 25, logger });
    await assert.rejects(tracker.promise('also-never-arrives'));
    tracker.cancelAll();
  });
});
