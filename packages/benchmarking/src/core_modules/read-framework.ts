import {iterateTimedEvents} from "../utils/iterateTimedEvents";
import {createFrameworkWriter} from "../utils/writers";
import {withReport} from "../utils/report";
import {getFrameworkContext} from "../utils/contexts";
import {createFrameworkReader} from "../utils/readers";
import {getBenchmarkConfig} from "./definitions";

export async function run() {
  const config = getBenchmarkConfig();
  const context = await getFrameworkContext();
  const benchmarkName = config.benchmarkName;
  const streamName = `${benchmarkName}-stream`.toString();
  const messageCount = config.messageCount;
  await createFrameworkWriter(context.datasource, streamName, messageCount)();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: config.benchmarkName,
      fn: createFrameworkReader(context.datasource, streamName, {
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
