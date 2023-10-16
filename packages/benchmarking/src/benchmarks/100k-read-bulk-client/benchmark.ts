import {iterateTimedEvents} from "../../utils/iterateTimedEvents";
import {createClientWriter} from "../../utils/writers";
import {withReport} from "../../utils/report";
import {getClientContext} from "../../utils/contexts";
import {getDefinition} from '../definitions';
import {createClientReader} from "../../utils/readers";

export async function run() {
  const context = await getClientContext();
  const benchmarkName = getDefinition("read-100k-bulk").control;
  const streamName = `${benchmarkName}-stream`.toString();
  const messageCount = 100000;
  const setup = createClientWriter(context.datasource, streamName, messageCount);
  await setup();

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: "read-100k-bulk",
      fn: createClientReader(context.datasource, streamName, {
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
