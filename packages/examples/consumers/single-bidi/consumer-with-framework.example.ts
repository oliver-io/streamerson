import { Topic } from '@streamerson/core';
import { StreamConsumer } from '@streamerson/consumer';

const consumer = new StreamConsumer({
    topic: new Topic('my-stream-topic'),
    bidirectional: true
});

consumer.registerStreamEvent<{ name: string }>('hello', async (e) => {
   return {
       howdy: `there, ${e.payload.name}`
   }
});

await consumer.connectAndListen();