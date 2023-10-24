import {createServer} from "../../../utils/fastify";

export async function run() {
  await createServer(8081, '0.0.0.0', {
    endpoints: [{
      method: 'POST',
      path: '/process',
      handler: async (request) => {
        return {
          sentBody: request.body
        }
      }
    }]
  });
}

run().catch(console.error);
