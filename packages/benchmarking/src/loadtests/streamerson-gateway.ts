import {createStreamersonGateway} from "../utils/gateway";

const GATEWAY_PORT = parseInt(process.env.STREAMERSON_GATEWAY_PORT || '8080');

export async function run() {
  await createStreamersonGateway(GATEWAY_PORT, '0.0.0.0', {
    endpoints: [{
      method: 'GET',
      path: '/bench',
      eventType: 'resp'
    }]
  });
}

run().catch(console.error);
