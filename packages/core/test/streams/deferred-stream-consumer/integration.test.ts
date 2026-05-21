import { mockLogger as mockLogging } from '@streamerson/test-utils';
import { MessageType } from '../../../src/types';
import { Readable } from 'stream';
import { streamAwaiter, StreamingDataSource } from '../../../src';
import { describe, test, spyOn } from 'bun:test';
import * as assert from 'node:assert';
import { ids } from '../../../src/utils/ids';

const mockLogger: any = mockLogging;
const uuidSpy = spyOn(ids, 'guuid');

const mockReadChannel = new StreamingDataSource({ port: 1024, host: 'localhost', logger: mockLogger });
const mockWriteChannel = new StreamingDataSource({ port: 1024, host: 'localhost', logger: mockLogger });

describe('when interceding as the stream indirectly', () => {
  test('we can read off a streamed response', async () => {
    const awaiter = streamAwaiter({
      logger: mockLogger,
      readChannel: mockReadChannel,
      writeChannel: mockWriteChannel,
      incomingStream: 'TEST_STREAM_INCOMING',
      outgoingStream: 'TEST_STREAM_OUTGOING',
    });

    const testMessageId = 'abc-123';
    uuidSpy.mockImplementationOnce(() => testMessageId);
    spyOn(mockWriteChannel, 'writeToStream').mockImplementationOnce((() => true) as any);
    spyOn(mockReadChannel, 'getReadStream').mockImplementationOnce((() =>
      Readable.from((async function* () {
        yield { messageId: testMessageId, payload: { hello: 'world!' } };
      })())) as any);

    const $dispatched = awaiter.dispatch('wat', MessageType.LOGIN);
    void awaiter.readResponseStream();
    assert.deepEqual(await $dispatched, { hello: 'world!' });
    awaiter.stateTracker.cancelAll();
  });
});
