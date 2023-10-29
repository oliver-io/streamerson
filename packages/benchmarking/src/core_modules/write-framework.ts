import {getFrameworkContext} from "../utils/contexts";
import {withReport} from "../utils/report";
import {iterateTimedEvents} from "../utils/iterateTimedEvents";
import {createBulkFrameworkWriter} from "../utils/writers";
import {getBenchmarkConfig} from "./definitions";

export async function run() {
  const context = await getFrameworkContext();
  const config = getBenchmarkConfig();
  const benchmarkName = config.benchmarkName;
  const streamName = `${benchmarkName}-stream`.toString();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: config.benchmarkName,
      fn: createBulkFrameworkWriter(context.datasource, streamName, config.messageCount)
    }
  ]));

  await benchmark();
}

run().catch(console.error);
