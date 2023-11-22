import {ConsumerGroupCluster} from '@streamerson/consumer-group';
import {topic} from "../utils/topic";
import Pino from 'pino';

export async function run() {
  console.log('Starting stream consumer CLUSTER....');
  const cluster = new ConsumerGroupCluster({
    topic,
    redisConfiguration: {
      host: process.env['STREAMERSON_REDIS_HOST'] || 'localhost',
      port: parseInt(process.env['STREAMERSON_REDIS_PORT'] || '0') || 6379,
    }
  }, {
    max: 3,
    min: 1,
    name: 'wat',
    processingTimeout: 1000,
    idleTimeout: 0
  }, './streamerson-group-consumer');

  await cluster.connectAndListen();
  await cluster.create();
  await cluster.fill();
}

run().catch(console.error);
