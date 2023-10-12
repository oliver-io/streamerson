import { StreamingDataSource } from '@streamerson/core';
import { config } from './config';

export async function run() {
  const a = new StreamingDataSource({
    host: config.redisHost,
    port: config.redisPort,
  });
  await a.connect();
  a.logger.info('Connected');
  // await a.disconnect();
}

run().catch(console.error);
