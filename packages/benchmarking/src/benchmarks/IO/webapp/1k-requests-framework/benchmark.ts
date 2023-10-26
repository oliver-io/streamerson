import {getClientContext, getFrameworkContext} from "../../../../utils/contexts";
import {withReport} from "../../../../utils/report";
import {iterateTimedEvents} from "../../../../utils/iterateTimedEvents";
import {makeHTTPRequest} from "../../../../utils/request";

export async function run() {
  const benchmarkName = "fastify-1k-requests";
  const messageCount = 1000;
  const context = await getFrameworkContext({ connect: false });
  const url = `http://${process.env.STREAMERSON_GATEWAY_HOST || 'localhost'}:${process.env.STREAMERSON_GATEWAY_PORT || 'localhost'}`;

  const benchmark = withReport(context, iterateTimedEvents([
    {
      name: benchmarkName,
      fn: async () => {
        let outstanding = [];
        for (let i = 0; i < messageCount; i++) {
          outstanding.push(makeHTTPRequest(url, '/bench', 'GET'));
        }

        await Promise.all(outstanding);
      }
    }
  ]));

  await benchmark();
}

run().catch(console.error);
