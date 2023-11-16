import {writeFile} from 'node:fs/promises';
import * as path from 'path';
import {iterateTimedEvents, StepEvent} from "./iterateTimedEvents";
import {logTimingEvent} from "./logging";
import {StreamingDataSource} from '@streamerson/core';
import {BenchmarkingContext} from "./contexts";

export async function buildReport(ctx: BenchmarkingContext, timingEvents: Array<StepEvent>) {
  const file = path.resolve('./benchmark-report.json');
  const body = JSON.stringify({experimentType: ctx.experimentType, timingEvents}, null, 2)

  ctx.logger.info('Writing report results to disk...');
  await writeFile(
    `/app/benchmarking/benchmark-report.json`,
    body
  );

  const url = (process.env['STREAMERSON_REPORT_PRESIGNED_URL'] ?? '').trim();

  if (url) {
    ctx.logger.info({ url }, 'Uploading report results to the presigned destination...');
    await fetch(url, {
      method: 'PUT',
      headers: {
        ["Content-Type"]: 'application/json'
      },
      body
    });
  }

  return file;
}

export function withReport<T extends BenchmarkingContext>(
  ctx: T,
  eventIterator: ReturnType<typeof iterateTimedEvents>
): () => Promise<void> {
  return async function () {
    const eventList = [];
    for await (const timingEvent of eventIterator) {
      eventList.push(timingEvent);

      logTimingEvent(ctx.logger, timingEvent, {
        logProperties: false
      });

      if (timingEvent.step === 'finalized') {
        try {
          if (ctx.connect) {
            if (ctx.datasource instanceof StreamingDataSource) {
              await ctx.datasource.abort();
            }

            await ctx.datasource.disconnect();
          }
        } catch (err) {
          ctx.logger.error({err}, 'Error disconnecting datasource');
        }
      }
    }

    ctx.logger.info('Building reports:');
    const reportPath = await buildReport(ctx, eventList);
    ctx.logger.info({reportPath}, 'Report built');
    await new Promise((r) => {
      setTimeout(r, 1000);
    })
    process.exit(0);
  }
}
