import {iterateTimedEvents} from "../../utils/iterateTimedEvents";
import {createClientWriter, createFrameworkWriter} from "../../utils/writers";
import {withReport} from "../../utils/report";
import {getClientContext, getFrameworkContext} from "../../utils/contexts";
import {getDefinition} from '../definitions';
import {createFrameworkReader, createClientReader} from "../../utils/readers";

export async function run() {
  const context = await getFrameworkContext();
  const benchmarkName = getDefinition("read-1k-bulk").control;
  const streamName = `${benchmarkName}-stream`.toString();
  const messageCount = 1000;
  const setup = createFrameworkWriter(context.datasource, streamName, messageCount);
  await setup();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: "read-1k-bulk",
      fn: createFrameworkReader(context.datasource, streamName, {
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
