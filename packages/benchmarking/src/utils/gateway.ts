import Fastify, {FastifyReply, FastifyRequest} from 'fastify';
import {topic} from './topic';
import { type StreamersonLogger } from '@streamerson/core';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import pino, { type Logger } from 'pino';

export async function createStreamersonGateway(port: number, host: string, options: {
  endpoints: Array<{
    method: 'GET' | 'POST';
    path: string;
    eventType: string;
  }>
}) {

  const app = Fastify({
    logger: pino({
      level: 'debug'
    }) as unknown as Logger,
  });

  await app.register(CreateGatewayPlugin({
    logger: pino({
      level: 'debug'
    }) as any,
    topic,
    streamOptions: {
      redisConfiguration: {
        host: process.env['STREAMERSON_REDIS_HOST'] || 'localhost'
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
