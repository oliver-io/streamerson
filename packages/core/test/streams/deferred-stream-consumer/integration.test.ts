import {mockLogger} from '@streamerson/test-utils';
import {MessageType} from '../../../src/types';
import {Readable} from 'stream';
import * as uuid from 'uuid';
import {streamAwaiter, StreamingDataSource} from '../../../src';
import {describe, mock, test} from 'node:test';
import * as assert from 'node:assert';

const uuidSpy = mock.method(uuid, 'v4');

const mockReadChannel = new StreamingDataSource({
	port: 1024,
	host: 'localhost',
	logger: mockLogger,
});

const mockWriteChannel = new StreamingDataSource({
	port: 1024,
	host: 'localhost',
	logger: mockLogger,
});

void describe('when interceding as the stream indirectly', async () => {
	await test('we can read off a streamed response', async () => {
		const awaiter = streamAwaiter({
			readChannel: mockReadChannel,
			writeChannel: mockWriteChannel,
			incomingStream: 'TEST_STREAM_INCOMING',
			outgoingStream: 'TEST_STREAM_OUTGOING',
		});

		const testMessageId = 'abc-123';
		uuidSpy.mock.mockImplementationOnce(() => testMessageId);

		mock.method(mockWriteChannel, 'writeToStream').mock.mockImplementationOnce(() => true);
		mock.method(mockReadChannel, 'getReadStream').mock.mockImplementationOnce(() =>
			Readable.from((async function * () {
				yield {
					messageId: testMessageId,
					payload: {
						hello: 'world!',
					},
				};
			})()),
		);

		const $dispatched = awaiter.dispatch('wat', MessageType.LOGIN);
		void awaiter.readResponseStream();
		assert.equal(await $dispatched, {
			hello: 'world!',
		});
	});
});
