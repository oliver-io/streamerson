import { StreamingDataSource } from '@streamerson/core';
import { config } from './config';

const MSG_COUNT = 100000;
export async function run() {
  const dataSource = new StreamingDataSource({
    host: config.redisHost,
    port: config.redisPort,
  });
  await dataSource.connect();
  const began = Date.now();

  dataSource.logger.info({
    start: began
  }, `Connected... writing ${MSG_COUNT} messages to the stream`);

  for (let i = 0; i < MSG_COUNT; i++) {
    let str = 'message' + i;
    await dataSource.writeToStream(
      'test',
      undefined,
      'test' as any,
      str,
      JSON.stringify({}),
      'test'
    );
  }

  const finishedWrites = Date.now();
  dataSource.logger.info({
    elapsed: finishedWrites - began
  }, `Wrote ${MSG_COUNT} messages to the stream`);
  const startedReads = new Date().getTime();
  dataSource.logger.info({
    start: startedReads
  }, 'Reading from stream...');

  const eventBatch = await dataSource.readAsSingle('test', '0', 1000);
  const end = (new Date()).getTime();
  let events = [];
  for (const [_streamTitle, entries] of eventBatch ?? []) {
    for (const rawEvent of entries) {
      events.push(rawEvent);
    }
  }

  dataSource.logger.info({
    total: `${end - began} ms`,
    write: `${finishedWrites - began} ms`,
    read: `${end - finishedWrites} ms`,
    wrote: MSG_COUNT,
    retrieved: `${events.length} events`,
  }, `Read ${MSG_COUNT} messages from the stream`);
}

run().catch(console.error);
