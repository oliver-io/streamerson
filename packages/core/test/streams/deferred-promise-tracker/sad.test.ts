import {v4 as uuid} from 'uuid';
import {mockLogger as logger} from '@streamerson/test-utils';
import {DEFAULT_TIMEOUT, DeferralTracker} from '../../../src';
const customTimeout = 1000;
import {describe, test} from 'node:test';
import * as assert from 'node:assert';

void describe('we get an error event when', async () => {
	await test(`the requested ID is not heard within default timeout (${DEFAULT_TIMEOUT}ms)`, async context => {
		const tracker = new DeferralTracker({logger});
		const waitOnReqThatTimesOut = async () => tracker.promise(uuid());
		context.mock.timers.enable();
		const $testResult = assert.rejects(waitOnReqThatTimesOut());
		context.mock.timers.tick(DEFAULT_TIMEOUT);
		await $testResult;
		context.mock.timers.reset();
	});

	await test(`the requested ID is not heard within a custom timeout of (${customTimeout}ms)`, async context => {
		const tracker = new DeferralTracker({
			timeout: customTimeout,
			logger,
		});
		const waitOnReqThatTimesOut = async () => tracker.promise(uuid());
		context.mock.timers.enable();
		const $testResult = waitOnReqThatTimesOut();
		context.mock.timers.tick(customTimeout);
		await assert.rejects($testResult, 'somethjing');
		context.mock.timers.reset();
	});
});
