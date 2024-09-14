import {StreamConsumer} from '@streamerson/consumer';
import {topic} from "../utils/topic";
import pino from 'pino';
import {StreamersonLogger} from '@streamerson/core';

export async function run() {
  console.log('Starting stream consumer....');
  const consumer = new StreamConsumer({
    logger: pino({
      level: 'warn'
    }) as any,
    topic,
    redisConfiguration: {
      host: process.env['STREAMERSON_REDIS_HOST'] || 'localhost',
      port: parseInt(process.env['STREAMERSON_REDIS_PORT'] || '0') || 6379
    },
    bidirectional: true,
    eventMap: {
      resp: (e) => {
        // throw new Error("WAT!?")
        return {
          hello: "world"
        }
      }
    }
  });

  await consumer.connectAndListen();
}

run().catch(console.error);
