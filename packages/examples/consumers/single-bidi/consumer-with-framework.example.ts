import { Topic } from '@streamerson/core';
import { StreamConsumer } from '@streamerson/consumer';

const consumer = new StreamConsumer({
    topic: new Topic('my-stream-topic'),
    bidirectional: true,
    // The response from this handler will be written to the topic's `producer` stream:
    eventMap: {
        ['hello']: (e) => {
            return {
                world: 'I am a stream processor'
            };
        }
    }
});

await consumer.connectAndListen();