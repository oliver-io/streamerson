import {iterateTimedEvents} from "../../../../../utils/iterateTimedEvents";
import {withReport} from "../../../../../utils/report";
import {getFrameworkContext} from "../../../../../utils/contexts";
import {createFrameworkStreamer} from "../../../../../utils/readers";
import {createFrameworkWriter} from "../../../../../utils/writers";

export async function run() {
  const context = await getFrameworkContext({experimentType: 'stream'});
  const benchmarkName = "read-1k-bulk";
  const streamName = `${benchmarkName}-stream`.toString();
  const messageCount = 1000;
  const setup = createFrameworkWriter(context.datasource, streamName, messageCount);
  await setup();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: benchmarkName,
      fn: createFrameworkStreamer(context.datasource, streamName, {
        batchSize: messageCount,
        failIfMoreRead: true,
        failIfFewerRead: true,
        startAt: 0,
        stopAt: messageCount
      })
    }
  ]));

  await benchmark();
}

run().catch(console.error);
