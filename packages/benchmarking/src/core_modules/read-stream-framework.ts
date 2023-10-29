import {getFrameworkContext} from "../utils/contexts";
import {createFrameworkWriter} from "../utils/writers";
import {withReport} from "../utils/report";
import {iterateTimedEvents} from "../utils/iterateTimedEvents";
import {createFrameworkStreamer} from "../utils/readers";
import {getBenchmarkConfig} from "./definitions";

export async function run() {
  const context = await getFrameworkContext({experimentType: 'stream'});
  const config = getBenchmarkConfig();
  const benchmarkName = config.benchmarkName;
  const streamName = `${benchmarkName}-stream`.toString();
  const messageCount = config.batchSize;
  await createFrameworkWriter(context.datasource, streamName, messageCount)();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: benchmarkName,
      fn: createFrameworkStreamer(context.datasource, streamName, {
        batchSize: config.batchSize,
        failIfMoreRead: true,
        failIfFewerRead: true,
        startAt: 0,
        stopAt: config.messageCount
      })
    }
  ]));

  await benchmark();
}

run().catch(console.error);
