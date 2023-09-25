import {MappedStreamEvent, MessageType, StreamingDataSource} from '@streamerson/core';
import {Transform} from 'stream';
import {Events, streamTopic} from "./config";

const channels = {
    read: new StreamingDataSource(),
    write: new StreamingDataSource()
}

await Promise.all([
    channels.read.connect(),
    channels.write.connect()
]);

const [readableStream, writeableStream] = [
    channels.read.getReadStream({
        stream: streamTopic.consumerKey()
    }),
    channels.write.getWriteStream({
        stream: streamTopic.producerKey()
    }),
];

const transform = new Transform({
    objectMode: true,
    transform: (e: MappedStreamEvent): MappedStreamEvent => {
        switch(e.messageType as unknown as Events) {
            case Events.HELLO_EVENT:
                return {
                    ...e,
                    payload: {
                        hello: 'world!  I just saw a message: \r\n\r\n' + JSON.stringify(e.payload, null, 2)
                    }
                };
            default:
                return {
                    ...e,
                    payload: {
                        error: 'Unknown message type',
                        statusCode: 400
                    }
                }
        }
    }
});

readableStream.pipe(transform).pipe(writeableStream);