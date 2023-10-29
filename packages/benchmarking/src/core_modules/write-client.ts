import {getClientContext} from "../utils/contexts";
import {withReport} from "../utils/report";
import {iterateTimedEvents} from "../utils/iterateTimedEvents";
import {createBulkClientWriter} from "../utils/writers";
import {getBenchmarkConfig} from "./definitions";

export async function run() {
  const config = getBenchmarkConfig();
  const context = await getClientContext();
  const streamName = `${config.benchmarkName}-stream`.toString();
  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: config.benchmarkName,
      fn: createBulkClientWriter(context.datasource, streamName, config.messageCount)
    }
  ]));

  await benchmark();
}

run().catch(console.error);
