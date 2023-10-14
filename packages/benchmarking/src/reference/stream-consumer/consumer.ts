import { StreamingDataSource } from '@streamerson/core';
import { config } from '../../../build/config';
import { StreamersonLogger } from "@streamerson/core";
import {iterateTimedEvents, StageInfo, StepEvent} from "../../benchUtils/iterateTimedEvents";
import {logTimingEvent} from "../../benchUtils/logging";
import {createDataSourceWriter} from "../../benchUtils/writers";
import {createBatchDataSourceReader} from "../../benchUtils/readers";

export async function run() {
  const dataSource = new StreamingDataSource({
    host: config.redisHost,
    port: config.redisPort,
  });
  await dataSource.connect();
  const began = Date.now();

  dataSource.logger.info({
    start: began
  }, `Connected... testing read-write of messages to the stream`);

  for await (const timingEvent of iterateTimedEvents([
    {
      name: `Write 1000 messages iteratively`,
      fn: createDataSourceWriter(dataSource, '1ktest', 1000)
    },
    {
      name: `Read 1000 messages as a batch`,
      fn: createBatchDataSourceReader(dataSource, '1ktest', 1000)
    }
  ])) {
    logTimingEvent(dataSource.logger, timingEvent, {
      logProperties: false
    });
  }
}

run().catch(console.error);
