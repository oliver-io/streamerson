import {StreamConsumer} from '@streamerson/consumer';
import {Events, streamTopic} from "./streamerson-gateway";

const consumer = new StreamConsumer({
    eventMap: {
        [Events.HELLO]: (e) => {
            return {
                world: 'I am a stream processor'
            };
        }
    },
    topic: streamTopic
});

await consumer.connectAndListen();
