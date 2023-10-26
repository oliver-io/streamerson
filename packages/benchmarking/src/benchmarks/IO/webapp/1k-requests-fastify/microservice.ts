import {createServer} from "../../../../utils/fastify";

const SERVICE_PORT = parseInt(process.env.STREAMERSON_MICROSERVICE_PORT || '8081');

export async function run() {
  await createServer(SERVICE_PORT, '0.0.0.0', {
    endpoints: [{
      method: 'POST',
      path: '/process/:id',
      handler: async (request) => {
        return {
          hello: "world"
        }
      }
    }]
  });
}

run().catch(console.error);
