import {StreamConsumer} from '@streamerson/consumer';
import {Events, streamTopic} from "./api";

const consumer = new StreamConsumer({
    eventMap: {
        [Events.HELLO_EVENT]: (e) => {
            return {
                world: 'I am a stream processor'
            };
        }
    },
    topic: streamTopic
});

await consumer.connectAndListen();