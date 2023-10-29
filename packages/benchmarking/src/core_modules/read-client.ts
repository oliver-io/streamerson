import {iterateTimedEvents} from "../utils/iterateTimedEvents";
import {createClientWriter} from "../utils/writers";
import {withReport} from "../utils/report";
import {getClientContext} from "../utils/contexts";
import {getBenchmarkConfig, getDefinition} from './definitions';
import {createClientReader} from "../utils/readers";
export async function run() {
  const config = getBenchmarkConfig();
  const context = await getClientContext();
  const streamName = `${config.benchmarkName}-stream`.toString();
  await createClientWriter(context.datasource, streamName, config.messageCount)();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: config.benchmarkName,
      fn: createClientReader(context.datasource, streamName, {
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
