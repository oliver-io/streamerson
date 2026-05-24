import { ConsumerGroupCluster } from '@streamerson/consumer';
import { topic } from '../utils/topic';
import path from 'path';

export async function run() {
  const cluster = new ConsumerGroupCluster(
    {
      topic,
      bidirectional: true,
      redisConfiguration: {
        host: process.env['STREAMERSON_REDIS_HOST'] || 'localhost',
        port: parseInt(process.env['STREAMERSON_REDIS_PORT'] || '0') || 6379,
      },
    },
    {
      count: 1,
      name: 'wat',
      processingTimeout: 1000,
      idleTimeout: 0,
    },
    // Bun runs the worker .ts directly — no compile step, no .js indirection.
    path.resolve(__dirname, 'streamerson-group-consumer.ts'),
  );

  await cluster.start();
}

run().catch(console.error);
