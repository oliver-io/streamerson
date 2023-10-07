import {StreamingDataSource, Topic} from '@streamerson/core';

export const readChannel = new StreamingDataSource(/* optional options */);

await readChannel.connect();

for await (const event of readChannel.getReadStream({
    // ... optional options, like batch size and timeouts
    topic: new Topic('my-example-topic')
})) {
    readChannel.logger.info(event, 'Received event!')
    // Do something with my streamed event?
    // We could even `.pipe()` this event to a Writable.
}