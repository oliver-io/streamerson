import { StreamingDataSource } from '@streamerson/core';

export async function run() {
  const a = new StreamingDataSource();
  await a.connect();
  await a.disconnect();
}

run().catch(console.error);
