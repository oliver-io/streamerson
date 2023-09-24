import {DeferralTracker} from '../../../src/deferral/deferred-promise-tracker';
import {mockLogger as logger} from '@streamerson/test-utils';
import {describe, test} from 'node:test';
import * as assertions from 'node:assert';

void describe('when creating a deferred promise tracker', () => {
	void test('we do not see errors in the happy path', async () => {
		const bootstrap = () => {
			const tracker = new DeferralTracker();
			return tracker;
		};

		assertions.doesNotThrow(bootstrap);
	});

	void test('we can pass a custom logger into the tracker', async () => {
		const options = {
			logger,
			someOtherProp: 'hello world',
		};

		const tracker = new DeferralTracker(options);
		tracker.logger.info('test message');
		assertions.match(
			logger.mocks.info.mock.calls?.[0]?.[0] as string,
			/test message/i,
		);
	});
});
