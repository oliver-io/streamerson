import {RouteOptions} from 'fastify';
import {
    streamAwaiter,
    buildStreamConfiguration,
    MessageType,
    StreamOptions,
} from '@streamerson/core';
import Pino from 'pino';
import fp from 'fastify-plugin';

const moduleLogger = Pino({
    base: {
        module: 'web_api',
    },
    transport: {
        target: 'pino-pretty',
    },
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
    logger?: Pino.Logger;
    defaultMeta: StreamOptions,
    routes: StreamersonRouteOptions | StreamersonRouteOptions[]
}) {
    const streamStateTrackers: ReturnType<typeof streamAwaiter>[] = [];
    const {defaultMeta, routes} = options;
    return fp(async (fastify) => {
        fastify.decorateRequest('sourceId', '');
        for (const route of Array.isArray(routes) ? routes : [routes]) {
            const defaultedRoute = {...defaultMeta, ...route};
            const configuration = buildStreamConfiguration(defaultedRoute, {
                logger:
                    options.logger ??
                    (fastify.log as unknown as typeof options.logger) ??
                    moduleLogger,
            });
            await Promise.all([
                configuration.readChannel.connect(),
                configuration.writeChannel.connect(),
            ]);
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