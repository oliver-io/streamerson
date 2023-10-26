import {createServer} from "../../../utils/fastify";
import {makeHTTPRequest} from "../../../utils/request";

const MICROSERVICE_URL = `http://${process.env.STREAMERSON_API_HOST ?? 'localhost'}:8081`;
export async function run() {
  await createServer(8080, '0.0.0.0', {
    endpoints: [{
      method: 'GET',
      path: '/api/:id',
      handler: async (request) => {
        return await makeHTTPRequest(MICROSERVICE_URL, '/process', 'POST', {
          receivedApiRequest: (request.params as { id: string }).id
        });
      }
    }]
  });
}

run().catch(console.error);
