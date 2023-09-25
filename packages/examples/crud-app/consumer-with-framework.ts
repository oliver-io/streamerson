import { StreamConsumer } from '@streamerson/consumer';
import {Events, streamTopic} from './config';

const consumer = new StreamConsumer({
    eventMap: {
        [Events.HELLO_EVENT]: (e) => {
            return {
                hello: 'world'
            };
        }
    },
    topic: streamTopic
});

await consumer.connectAndListen();