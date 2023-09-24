import {mockLogger as logger} from '@streamerson/test-utils';
import {v4 as uuid} from 'uuid';
import {DEFAULT_TIMEOUT, DeferralTracker, type NullablePrimitive} from '../../../src';
import {MessageType} from '../../../src/types';
import {describe, test} from 'node:test';
import * as assert from 'node:assert';

type MinimalEventInterface = {
	messageId: string;
} & Record<string, NullablePrimitive>;

void describe('we get a response when', async () => {
	await test('the pending occurs before arrival', async () => {
		const testId = uuid();
		const tracker = new DeferralTracker({logger});
		const testEvent: MinimalEventInterface = {
			messageId: testId,
			someStuff: 'ok',
		};
		const $pending = tracker.promise<typeof testEvent>(testId);
		tracker.emit('response', testEvent);
		const response = await $pending;
		assert.equal(response, testEvent);
	});

	await test('the pending occurs after arrival', async () => {
		const testId = uuid();
		const tracker = new DeferralTracker({logger});
		const testEvent: MinimalEventInterface = {
			messageId: testId,
			testDataPayload: 'hello world',
		};
		tracker.emit('response', testEvent);
		const $pending = tracker.promise<typeof testEvent>(testId);
		const response = await $pending;
		assert.equal(response, testEvent);
	});

	await test('there are other promises pending', async () => {
		const tracker = new DeferralTracker({logger});
		const specialTestId = uuid();
		const testEvent: {messageId: string; someOtherStuff: string} = {
			messageId: specialTestId,
			someOtherStuff: 'wat',
		};
		const $pending = tracker.promise<typeof testEvent>(specialTestId);
		const testIds = Array(10).fill('').map(() => uuid());

		for (const testId of testIds) {
			tracker.emit('response', {
				messageId: testId,
				messageDestination: 'test',
				messageType: MessageType.RESPONSE,
				payload: {regularOldPayload: 'some data we do not care about'},
				messageHeaders: 'nil',
			});
		}

		tracker.emit('response', testEvent);
		const response = await $pending;
		assert.equal(response, testEvent);
	});

	await test('we read out-of-order pending promises', async () => {
		const tracker = new DeferralTracker({logger});
		const testData = Array(10).fill('').map(() => {
			const preFilled = Math.random() >= 0.5;
			const id = uuid();
			return {
				promise: preFilled ? null : tracker.promise(id),
				event: {
					messageId: id,
					messageDestination: 'test',
					messageType: MessageType.RESPONSE,
					payload: {some: 'stuff'},
					messageHeaders: 'nil',
				},
			};
		});

		for (const {event} of testData) {
			tracker.emit('response', event);
		}

		// Iterate randomly through generated promises:
		do {
			const randomIndex = Math.floor(Math.random() * (testData.length));
			const [{promise, event}] = testData.splice(randomIndex, 1);
			if (promise) {
				assert.equal(await promise, event);
			} else {
				assert.equal(await tracker.promise<typeof event>(event.messageId), event);
			}
		} while (testData.length);
	});

	await test('the response occurs just before a timeout', async context => {
		const testId = uuid();
		const tracker = new DeferralTracker({logger});
		const testEvent = {
			messageId: testId,
			somePayload: {
				myData: {
					ok: true,
				},
			},
		};

		context.mock.timers.enable(['setTimeout']);
		const $pending = tracker.promise<typeof testEvent>(testId);
		context.mock.timers.tick(DEFAULT_TIMEOUT - 1);
		tracker.emit('response', testEvent);
		const response = await $pending;
		assert.equal(response, testEvent);
	});
});
