/**
 * LEGACY MOCK TEST — fully mocked (spied datasource methods, no Redis) despite living
 * beside the deferred-stream-consumer integration coverage. Superseded by the real
 * integration suites under `test/streams/` that exercise the awaiter/correlation path
 * against a live Redis. Kept in place — not renamed/deleted — so git history and prior
 * discussion stay cheap to follow. Do not extend; add new coverage to the real
 * integration files instead.
 */
import {mockLogger} from '@streamerson/test-utils';
import * as uuid from 'uuid';
import {ids, streamAwaiter, StreamingDataSource} from '../../../src';
import {MessageType} from '../../../src/types';
import { describe, test, spyOn } from "bun:test";
import * as assert from 'node:assert';

const uuidSpy = spyOn(ids, 'guuid');

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
	void test('we can read off an injected response', async () => {
		const awaiter = streamAwaiter({
			logger: mockLogger,
			readChannel: mockReadChannel,
			writeChannel: mockWriteChannel,
			incomingStream: 'TEST_STREAM_INCOMING',
			outgoingStream: 'TEST_STREAM_OUTGOING',
		});

		spyOn(mockWriteChannel, 'writeToStream').mockImplementationOnce((() => true) as any);

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
		uuidSpy.mockImplementationOnce(() => testMessageId);
		const $dispatched = awaiter.dispatch('wat', MessageType.LOGIN);
		const testEventResponse = {
			messageId: testMessageId,
			payload: {
				hello: 'world!',
			},
		};
		awaiter.stateTracker.emit('response', testEventResponse);
		assert.equal(await $dispatched, testEventResponse.payload);
		awaiter.stateTracker.cancelAll();
	});
});
