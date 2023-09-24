import {mockLogger} from '@streamerson/test-utils';
import * as uuid from 'uuid';
import {streamAwaiter, StreamingDataSource} from '../../../src';
import {MessageType} from '../../../src/types';
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

void describe('when interceding as the stream directly', async () => {
	await test('we can read off an injected response', async () => {
		const awaiter = streamAwaiter({
			readChannel: mockReadChannel,
			writeChannel: mockWriteChannel,
			incomingStream: 'TEST_STREAM_INCOMING',
			outgoingStream: 'TEST_STREAM_OUTGOING',
		});

		mock.method(mockWriteChannel, 'writeToStream').mock.mockImplementationOnce(() => true);

		// (mockWriteChannel.writeToStream as ReturnType<typeof mock.fn>).mockReturnValueOnce(true);
		// (mockReadChannel.getReadStream as ReturnType<typeof jest.fn>).mockReturnValueOnce(
		//     Readable.from((async function *(){
		//         yield {
		//             messageId: 'abc-123',
		//             payload: {
		//                 hello: 'world!'
		//             }
		//         }
		//     })())
		// );

		const testMessageId = 'abc-123';
		uuidSpy.mock.mockImplementation(() => testMessageId);
		const $dispatched = awaiter.dispatch('wat', MessageType.LOGIN);
		const testEventResponse = {
			messageId: testMessageId,
			payload: {
				hello: 'world!',
			},
		};
		awaiter.stateTracker.emit('response', testEventResponse);
		assert.equal(await $dispatched, testEventResponse.payload);
	});
});
