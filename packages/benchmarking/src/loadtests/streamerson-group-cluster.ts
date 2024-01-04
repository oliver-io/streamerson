import {ConsumerGroupCluster} from '@streamerson/consumer';
import {topic} from "../utils/topic";
import path from "path";
import fs from 'fs';

export async function run() {
  console.log('Starting stream consumer CLUSTER....');
  console.log('Debug da env', {
    STREAMERSON_BENCHMARK_DIRECTORY: process.env.STREAMERSON_BENCHMARK_DIRECTORY,
    STREAMERSON_BENCHMARK_FILE_TARGET: process.env.STREAMERSON_BENCHMARK_FILE_TARGET,
    fileAttemptDir: path.resolve(process.env.STREAMERSON_BENCHMARK_DIRECTORY),
    fileAttemptFull: path.resolve(
      'src',
      process.env.STREAMERSON_BENCHMARK_DIRECTORY,
      process.env.STREAMERSON_BENCHMARK_FILE_TARGET,
      '../streamerson-group-consumer.js'
    ),
    // curr: fs.readdirSync('/app'),
    // dir: fs.readdirSync('/app/benchmarking/src'),
  });

  const cluster = new ConsumerGroupCluster({
    topic,
    bidirectional: true,
    consumerGroupInstanceConfig: {
      groupId: 'wat',
      groupMemberId: 'configurator'
    },
    redisConfiguration: {
      host: process.env['STREAMERSON_REDIS_HOST'] || 'localhost',
      port: parseInt(process.env['STREAMERSON_REDIS_PORT'] || '0') || 6379,
    }
  }, {
    max: 3,
    min: 3,
    name: 'wat',
    processingTimeout: 1000,
    idleTimeout: 0
  }, path.resolve(
    'src',
    process.env.STREAMERSON_BENCHMARK_DIRECTORY,
    process.env.STREAMERSON_BENCHMARK_FILE_TARGET,
    '../streamerson-group-consumer.js'
  ));

  console.log('\r\nConnecting cluster configurator')
  await cluster.incomingChannel.connect();
  console.log('Creating cluster definition...')
  await cluster.create();
  console.log('Cluster topic options...');
  console.log(cluster.topic);
  console.log(cluster.topicOptions);
  console.log('Filling cluster with members......')
  await cluster.fill();
}

run().catch(console.error);
