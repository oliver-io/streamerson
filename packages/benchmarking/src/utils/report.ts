import {writeFile} from 'node:fs/promises';
import * as path from 'path';
import {Redis} from 'ioredis';
import {iterateTimedEvents, StepEvent} from "./iterateTimedEvents";
import {logTimingEvent} from "./logging";
import {type StreamersonLogger, StreamingDataSource} from '@streamerson/core';
import Pino from 'pino';
import {
  BenchmarkingContext,
  ClientBenchmarkingContext,
  FrameworkBenchmarkingContext,
  getClientContext,
  getFrameworkContext
} from "./contexts";

export async function buildReport(ctx: BenchmarkingContext, timingEvents: Array<StepEvent>) {
  const file = path.resolve('./benchmark-report.json');
  await writeFile(
    `/app/benchmarking/benchmark-report.json`,
    JSON.stringify({ experimentType: ctx.experimentType, timingEvents }, null, 2)
  );
  return file;
}

export function withReport<T extends BenchmarkingContext>(
  ctx: T,
  eventIterator: ReturnType<typeof iterateTimedEvents>
): () => Promise<void> {
  return async function() {
    const eventList = [];
    for await (const timingEvent of eventIterator) {
      eventList.push(timingEvent);

      logTimingEvent(ctx.logger, timingEvent, {
        logProperties: false
      });

      if (timingEvent.step === 'finalized') {
        ctx.datasource.disconnect();
      }
    }

    ctx.logger.info('Building reports:');
    const reportPath = await buildReport(ctx, eventList);
    ctx.logger.info({reportPath}, 'Report built');
  }
}
