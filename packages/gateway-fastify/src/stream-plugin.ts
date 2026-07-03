import { RouteOptions } from 'fastify';
import {
  createStreamersonLogger, DEFAULT_TIMEOUT,
  MessageType,
  ReconnectOptions,
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
  timeout?: number;
  reconnect?: ReconnectOptions;
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

      channels.push(readChannel, writeChannel);

      existingAwaiter = streamAwaiter({
        logger: (options.logger ?? moduleLogger) as any,
        readChannel,
        writeChannel,
        incomingStream: inStream,
        outgoingStream: outStream,
        timeout: options.timeout,
        reconnect: options.reconnect
      });
      inOutRecord[binding] = existingAwaiter;
      streamStateTrackers.push(existingAwaiter);
    }

    return existingAwaiter;
  }

  const streamStateTrackers: ReturnType<typeof streamAwaiter>[] = [];
  const channels: StreamingDataSource[] = [];
  const readerDisposers: Array<() => Promise<void>> = [];
  const { routes } = options;
  return fp(async (fastify) => {
    fastify.decorateRequest('sourceId', '');
    for (const route of Array.isArray(routes) ? routes : [routes]) {

      if (!route) {
        continue;
      }

      if (!route.messageType) {
        throw new Error(
          `CreateGatewayPlugin: route "${route.method ?? '?'} ${route.url ?? '?'}" is missing the required "messageType". A route without it dispatches an unhandled message type that no worker matches, so every request to it silently times out.`
        );
      }

      const defaultedRoute = { ...(route?.topic ?? options.topic).meta(), ...route };
      const messageStream = (route?.topic ?? options.topic).consumerKey();
      const responseStream = (route?.topic ?? options.topic).producerKey();

      const streamStateTracker = await getStreamAwaiter(responseStream, messageStream);


      fastify.route({
        ...defaultedRoute,
        handler: async (request, reply) => {
          // Wire the HTTP request's close to an AbortSignal so a client that disconnects (or
          // times out client-side) cancels its pending/frozen dispatch instead of leaking a
          // deferral through a reader outage (GW9/R8). `route.timeout` (Q6) overrides the
          // plugin default for this route's dispatch.
          const ac = new AbortController();
          const onClientClose = () => { if (!reply.sent) ac.abort(); };
          request.raw.on('close', onClientClose);
          try {
            const response = await streamStateTracker.dispatch(
              JSON.stringify(request.body ?? {}),
              route.messageType as MessageType,
              request.sourceId,
              undefined,
              undefined,
              { signal: ac.signal, timeout: route.timeout }
            );
            reply.send(response);
          } catch (err) {
            const message = String((err as Error)?.message ?? '');
            if (message.includes('client disconnected')) {
              return; // client is gone; nothing to send
            }
            // The response reader gave up reconnecting (reconnect.maxAttempts) — an
            // infrastructure outage, distinct from a worker error: 503, not 500.
            if (message.includes('reader unavailable')) {
              if (!reply.sent) {
                reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'stream reader unavailable' });
              }
              return;
            }
            throw err; // dispatch timeouts etc. → Fastify 500
          } finally {
            request.raw.off('close', onClientClose);
          }
        }
      });
      fastify.log.info(`... Sending incoming messages to ${messageStream}`);
      fastify.log.info(`... Listening for responses from ${responseStream}`);
    }

    // Arm the response readers BEFORE serving (registration awaits this), so a fast first
    // request can't beat the reader up and miss its response (GW15/R9). Each reader captures
    // its producer-stream tip here, closing the cold-boot join race. A failure to arm fails
    // registration loudly (self-heal is for runtime drops, not boot).
    const disposers = await Promise.all(
      streamStateTrackers.map((stateTracker) => stateTracker.readResponseStream())
    );
    readerDisposers.push(...disposers);

    // Own the lifecycle of everything provisioned above. On server close, tear down each
    // reader (stopping any in-progress reconnect first — the disposer is awaitable, R4/§7)
    // and disconnect every channel. Without this, each unique topic-binding leaks 4 Redis
    // connections (read + write channel, each controllable = data + control) on every close,
    // until Redis hits maxclients (GW5).
    fastify.addHook('onClose', async () => {
      for (const dispose of readerDisposers) {
        try { await dispose(); } catch { /* best-effort teardown */ }
      }
      await Promise.allSettled(channels.map((channel) => channel.disconnect()));
    });
  }, {});
}
