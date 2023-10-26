import {StreamConsumer} from '@streamerson/consumer';
import {topic} from "../../../../utils/topic";

export async function run() {
  const consumer = new StreamConsumer({
    topic,
    redisConfiguration: {
      host: 'redis',
      port: 6379
    },
    bidirectional: true,
    eventMap: {
      resp: (e) => {
        return {
          hello: "world"
        }
      }
    }
  });

  await consumer.connectAndListen();
}

run().catch(console.error);
