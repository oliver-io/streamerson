import {RouteOptions} from 'fastify';
import {
  createStreamersonLogger, DEFAULT_TIMEOUT,
  MessageType,
  streamAwaiter,
  StreamersonLogger,
  StreamingDataSource,
  StreamOptions,
  Topic,
} from '@streamerson/core';
import fp from 'fastify-plugin';

const moduleLogger = createStreamersonLogger({
  module: 'streamerson_gateway_fastify',
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
} & Partial<StreamOptions> &
  Partial<RouteOptions>;

export function CreateGatewayPlugin(options: {
  logger?: StreamersonLogger;
  streamOptions?: Partial<StreamOptions>;
  topic: Topic;
  routes: StreamersonRouteOptions | StreamersonRouteOptions[],
  timeout?: number
}) {
  const streamStateTrackers: ReturnType<typeof streamAwaiter>[] = [];
  const {routes} = options;
  return fp(async (fastify) => {
    fastify.decorateRequest('sourceId', '');
    for (const route of Array.isArray(routes) ? routes : [routes]) {
      if (!route) {
        continue;
      }
      const defaultedRoute = {...options.topic.meta(), ...route};
      const [readChannel, writeChannel] = [
        new StreamingDataSource({
          logger: options.logger as any,
          controllable: true,
          host: options.streamOptions?.redisConfiguration?.host,
          port: options.streamOptions?.redisConfiguration?.port,
        }),
        new StreamingDataSource({
          logger: options.logger as any,
          controllable: true,
          host: options.streamOptions?.redisConfiguration?.host,
          port: options.streamOptions?.redisConfiguration?.port,
        })
      ];

      await Promise.all([
        readChannel.connect(),
        writeChannel.connect(),
      ]);

      const messageStream = options.topic.consumerKey();
      const responseStream = options.topic.producerKey();

      const streamStateTracker = streamAwaiter({
        logger: (options.logger ?? moduleLogger) as any,
        readChannel,
        writeChannel,
        incomingStream: responseStream,
        outgoingStream: messageStream,
        timeout: options.timeout
      });

      const trackerIndex = streamStateTrackers.push(streamStateTracker) - 1;
      fastify.route({
        ...defaultedRoute,
        handler: async (request, reply) => {
          try {
            const response = await streamStateTrackers[trackerIndex].dispatch(
              JSON.stringify(request.body ?? {}),
              route.messageType as MessageType,
              request.sourceId
            );
            reply.send(response);
            return;
          } catch (err) {
            console.warn(
              {
                trackers: streamStateTrackers,
                index: trackerIndex,
              },
              'Freakin debug.....',
              err
            );
            throw err;
          }
        },
      });

      fastify.log.info(`... Sending incoming messages to ${messageStream}`);
      fastify.log.info(`... Listening for responses from ${responseStream}`);
      for (const stateTracker in streamStateTrackers) {
        streamStateTrackers[stateTracker].readResponseStream().catch(err => {
          throw err;
        });
      }
    }
  }, {});
}
