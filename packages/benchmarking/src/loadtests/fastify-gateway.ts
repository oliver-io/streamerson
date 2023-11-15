import {createServer} from "../utils/fastify";
import {makeHTTPRequest} from "../utils/request";

const MICROSERVICE_URL = `http://${
  process.env.STREAMERSON_MICROSERVICE_HOST || 'localhost'
}:${
  process.env.STREAMERSON_MICROSERVICE_PORT || 8081
}`;

const GATEWAY_PORT = parseInt(process.env.STREAMERSON_GATEWAY_PORT || '8080');

console.log('Routing traffic to '+MICROSERVICE_URL);

export async function run() {
  await createServer(GATEWAY_PORT, '0.0.0.0', {
    endpoints: [{
      method: 'GET',
      path: '/bench',
      handler: async (request) => {
        return await makeHTTPRequest(MICROSERVICE_URL, '/process/:id', 'POST', {
          hello: "world",
          receivedApiRequest: (request.params as { id: string }).id
        });
      }
    }]
  });
}

run().catch(console.error);
