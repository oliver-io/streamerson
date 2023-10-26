import Fastify, {FastifyReply, FastifyRequest} from 'fastify';
import {topic} from './topic';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';

export async function createStreamersonGateway(port: number, host: string, options: {
  endpoints: Array<{
    method: 'GET' | 'POST';
    path: string;
    eventType: string;
  }>
}) {

  const app = Fastify({
    logger: true
  });

  await app.register(CreateGatewayPlugin({
    logger: app.log as any,
    topic,
    streamOptions: {
      redisConfiguration: {
        host: 'redis'
      }
    },
    routes: options.endpoints.map((endpoint) => {
      return {
        method: endpoint.method,
        url: endpoint.path,
        messageType: endpoint.eventType
      }
    })
  }));

  await app.listen({port, host});
  return app;
}
