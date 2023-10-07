import {MappedStreamEvent, StreamingDataSource, Topic} from '@streamerson/core';
import {Transform} from 'stream';

const streamTopic = new Topic('my-stream-topic');

const channels = {
    read: new StreamingDataSource(),
    write: new StreamingDataSource()
}

await Promise.all([
    channels.read.connect(),
    channels.write.connect()
]);

const [readableStream, writableStream] = [
    channels.read.getReadStream({
        stream: streamTopic.consumerKey()
    }),
    channels.write.getWriteStream({
        stream: streamTopic.producerKey()
    }),
];

const transform = new Transform({
    objectMode: true,
    transform: function (e: MappedStreamEvent, _, cb) {
        switch(e.messageType as string) {
            case 'hello':
                this.push(({
                    ...e,
                    payload: {
                        hello: 'world!  I just saw a message: \r\n\r\n' + JSON.stringify(e.payload, null, 2)
                    }
                } as MappedStreamEvent));
                cb();
                break;
            default:
                this.push(({
                    ...e,
                    payload: {
                        error: 'Unknown message type',
                        statusCode: 400
                    }
                } as MappedStreamEvent));
                cb();
                break;
        }
    }
});

readableStream.pipe(transform).pipe(writableStream);