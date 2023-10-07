import {StreamingDataSource, Topic} from '@streamerson/core';

const readChannel = new StreamingDataSource();

await readChannel.connect();

const topic = new Topic('my-stream-topic');

const readableStream = readChannel.getReadStream({
    stream: topic.consumerKey()
});

// We now have an EventEmitter that will broadcast on events from the Redis Stream:
readableStream.on('data', (event) => {
    readChannel.logger.info(event, 'Just received an event!');
});