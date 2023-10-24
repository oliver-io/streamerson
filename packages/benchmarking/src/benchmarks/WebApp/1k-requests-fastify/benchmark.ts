import {getFrameworkContext} from "../../../utils/contexts";
import {createFrameworkWriter} from "../../../utils/writers";
import {withReport} from "../../../utils/report";
import {iterateTimedEvents} from "../../../utils/iterateTimedEvents";
import {makeHTTPRequest} from "../../../utils/request";
import PQueue from 'p-queue';

export async function run() {
  const benchmarkName = "read-1k-iterative";
  const messageCount = 1000;
  const context = await getFrameworkContext({ connect: false });

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: benchmarkName,
      fn: async () => {
        let outstanding = [];
        for (let i = 0; i < messageCount; i++) {
          outstanding.push(makeHTTPRequest(`http://${process.env.STREAMERSON_API_HOST ?? 'localhost'}:8080`, '/api/123', 'GET'));
        }

        await Promise.all(outstanding);
      }
    }
  ]));

  await benchmark();
}

run().catch(console.error);
