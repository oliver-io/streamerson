import { Topic } from '@streamerson/core';
import { StreamConsumer } from '@streamerson/consumer';

const consumer = new StreamConsumer({
    topic: new Topic('my-stream-topic'),
    bidirectional: false,
    eventMap: {
        ['hello']: (e) => {
            console.log('I just got an event!')
        }
    }
});

await consumer.connectAndListen();