import { RouteOptions } from 'fastify';
import {
  createStreamersonLogger, DEFAULT_TIMEOUT,
  MessageType,
  streamAwaiter,
  StreamersonLogger,
  StreamingDataSource,
  StreamOptions,
  Topic
} from '@streamerson/core';
import fp from 'fastify-plugin';

const moduleLogger = createStreamersonLogger({
  module: 'streamerson_gateway_fastify'
});

declare module 'fastify' {
  interface FastifyRequest {
    sourceId: string;
  }
}

type StreamersonRouteOptions = {
  method: string;
  url: string;
  messageType: string;
  timeout?: number;
  topic?: Topic
} & Partial<StreamOptions> &
  Partial<RouteOptions>;

export function CreateGatewayPlugin(options: {
  logger?: StreamersonLogger;
  streamOptions?: Partial<StreamOptions>;
  topic: Topic;
  routes: StreamersonRouteOptions | StreamersonRouteOptions[],
  timeout?: number
}) {
  const inOutRecord: Record<string, ReturnType<typeof streamAwaiter>> = {};

  async function getStreamAwaiter(inStream: string, outStream: string) {
    const binding = `${inStream}:${outStream}`;
    let existingAwaiter = inOutRecord[binding];
    if (!existingAwaiter) {
      const [readChannel, writeChannel] = [
        new StreamingDataSource({
          logger: options.logger as any,
          controllable: true,
          host: options.streamOptions?.redisConfiguration?.host,
          port: options.streamOptions?.redisConfiguration?.port
        }),
        new StreamingDataSource({
          logger: options.logger as any,
          controllable: true,
          host: options.streamOptions?.redisConfiguration?.host,
          port: options.streamOptions?.redisConfiguration?.port
        })
      ];

      await Promise.all([
        readChannel.connect(),
        writeChannel.connect()
      ]);

      existingAwaiter = streamAwaiter({
        logger: (options.logger ?? moduleLogger) as any,
        readChannel,
        writeChannel,
        incomingStream: inStream,
        outgoingStream: outStream,
        timeout: options.timeout
      });
      inOutRecord[binding] = existingAwaiter;
      streamStateTrackers.push(existingAwaiter);
    }

    return existingAwaiter;
  }

  const streamStateTrackers: ReturnType<typeof streamAwaiter>[] = [];
  const { routes } = options;
  return fp(async (fastify) => {
    fastify.decorateRequest('sourceId', '');
    for (const route of Array.isArray(routes) ? routes : [routes]) {

      if (!route) {
        continue;
      }

      const defaultedRoute = { ...(route?.topic ?? options.topic).meta(), ...route };
      const messageStream = (route?.topic ?? options.topic).consumerKey();
      const responseStream = (route?.topic ?? options.topic).producerKey();

      const streamStateTracker = await getStreamAwaiter(responseStream, messageStream);


      fastify.route({
        ...defaultedRoute,
        handler: async (request, reply) => {
          const response = await streamStateTracker.dispatch(
            JSON.stringify(request.body ?? {}),
            route.messageType as MessageType,
            request.sourceId
          );
          reply.send(response);
        }
      });
      fastify.log.info(`... Sending incoming messages to ${messageStream}`);
      fastify.log.info(`... Listening for responses from ${responseStream}`);
    }

    for (const stateTracker of streamStateTrackers) {
      stateTracker.readResponseStream().catch((err: unknown) => {
        throw err;
      });
    }
  }, {});
}
