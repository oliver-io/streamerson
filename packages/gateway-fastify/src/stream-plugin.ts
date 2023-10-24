import {RouteOptions} from 'fastify';
import {
    streamAwaiter,
    buildStreamConfiguration,
    MessageType,
    StreamOptions, StreamMessageFlowModes, Topic, StreamersonLogger,
} from '@streamerson/core';
import Pino from 'pino';
import fp from 'fastify-plugin';

const moduleLogger = Pino({
    base: {
        module: 'streamerson_gateway_fastify',
    }
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
    routes: StreamersonRouteOptions | StreamersonRouteOptions[]
}) {

    const defaultStreamOptions = {
        meta: options.topic?.meta() ?? {
            mode: 'ORDERED' as StreamMessageFlowModes.ORDERED,
            namespace: 'default',
            sharded: false
        }
    }

    const streamOptions = Object.assign(
        {... defaultStreamOptions},
        {... options.streamOptions ?? {}}
    );

    const streamStateTrackers: ReturnType<typeof streamAwaiter>[] = [];
    const {routes} = options;
    return fp(async (fastify) => {
        fastify.decorateRequest('sourceId', '');
        for (const route of Array.isArray(routes) ? routes : [routes]) {
            if (!route) {
                continue;
            }
            const defaultedRoute = {...streamOptions, ...route};
            const configuration = buildStreamConfiguration(options.topic, {
                logger:
                    options.logger ??
                    (fastify.log as unknown as typeof options.logger) ??
                    moduleLogger,
            });

            await Promise.all([
                configuration.readChannel.connect(),
                configuration.writeChannel.connect(),
            ]);

            fastify.log.info(`Stream connected for ${configuration.incomingStream}`)
            fastify.log.info(`Stream connected for ${configuration.outgoingStream}`)

            const streamStateTracker = streamAwaiter(configuration);
            const trackerIndex = streamStateTrackers.push(streamStateTracker) - 1;
            fastify.route({
                ...defaultedRoute,
                handler: async (request, reply) => {
                    try {
                        const response = await streamStateTrackers[trackerIndex].dispatch(
                            JSON.stringify(request.body),
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
        }
    }, {});
}
