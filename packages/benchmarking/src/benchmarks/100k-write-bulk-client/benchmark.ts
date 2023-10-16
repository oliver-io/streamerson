import {iterateTimedEvents} from "../../utils/iterateTimedEvents";
import {createBulkClientWriter} from "../../utils/writers";
import {withReport} from "../../utils/report";
import {getClientContext} from "../../utils/contexts";
import {getDefinition} from '../definitions';

export async function run() {
  const context = await getClientContext();
  const benchmarkName = getDefinition("write-100k-bulk").control;
  const streamName = `${benchmarkName}-stream`.toString();
  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: "write-100k-bulk",
      fn: createBulkClientWriter(context.datasource, streamName, 100000)
    }
  ]));

  await benchmark();
}

run().catch(console.error);
