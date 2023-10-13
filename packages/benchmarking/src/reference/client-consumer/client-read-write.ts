import Redis from 'ioredis';
import { config } from '../../config';
import pino from 'pino'

const logger = pino();

const MSG_COUNT = 100000;
export async function run() {
  const dataSource = new Redis({
    host: config.redisHost,
    port: config.redisPort,
  });
  await dataSource.connect();
  const began = Date.now();

  logger.info({
    start: began
  }, `Connected... writing ${MSG_COUNT} messages to the stream`);

  for (let i = 0; i < MSG_COUNT; i++) {
    let str = 'message' + i;
    await dataSource.xadd(
      'test',
      '*',
      str, // MessageId
      'test', // Message packing; TODO: Make this configurable
      '', // MessageDestination
      'nil', // Message headers
      'json', // Label for caution and pack type
      'test',
      'UnoccupiedField',
      JSON.stringify('{}'), // Payload
    );
  }

  const finishedWrites = Date.now();
  logger.info({
    elapsed: finishedWrites - began
  }, `Wrote ${MSG_COUNT} messages to the stream`);
  const startedReads = new Date().getTime();
  logger.info({
    start: startedReads
  }, 'Reading from stream...');

  const eventBatch = (await dataSource.call(
    'XREAD',
    'BLOCK',
    1000,
    // "COUNT", 10,
    'STREAMS',
    'test',
    '',
  ) ?? []) as [id:string, batch: Array<[k: string, v: string]>];
  const end = (new Date()).getTime();
  let events = [];
  for (const event of eventBatch ?? []) {
    for (const rawEvent of event[1]) {
      events.push(rawEvent);
    }
  }

  logger.info({
    total: `${end - began} ms`,
    write: `${finishedWrites - began} ms`,
    read: `${end - finishedWrites} ms`,
    wrote: MSG_COUNT,
    retrieved: `${events.length} events`,
  }, `Read ${MSG_COUNT} messages from the stream`);
}

run().catch(console.error);
