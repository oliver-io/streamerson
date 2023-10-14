import Redis from 'ioredis';
import {config} from '../../../build/config';
import pino from 'pino'
import {iterateTimedEvents} from "../../benchUtils/iterateTimedEvents";
import {createClientWriter} from "../../benchUtils/writers";
import {logTimingEvent} from "../../benchUtils/logging";

const logger = pino();

export async function run() {
  const dataSource = new Redis(config.redisPort ?? 6379, config.redisHost ?? 'localhost');

  logger.info(`Connected... testing CLIENT read-write of messages to the stream`);
  logger.info({ env: process.env, config });

  for await (const timingEvent of iterateTimedEvents([
    {
      name: `Write 1000 messages iteratively`,
      fn: createClientWriter(dataSource, '1ktest', 1000)
    },
    {
      name: `Read 1000 messages as a batch`,
      fn: createClientWriter(dataSource, '1ktest', 1000)
    }
  ])) {
    logTimingEvent(logger, timingEvent, {
      logProperties: false
    });
  }
}

run().catch(console.error);
