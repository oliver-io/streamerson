import fastify from 'fastify';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import {Topic} from "@streamerson/core";

export enum Events {
    HELLO = 'hello'
}

export const streamTopic = new Topic('my-stream-topic');

const apiServer = fastify({
    logger: true
});

const streamPlugin = CreateGatewayPlugin({
    logger: apiServer.log,
    topic: streamTopic,
    routes: {
        method: 'GET',
        url: '/',
        messageType: Events.HELLO,
        timeout: 1000
    }
});

await apiServer.register(streamPlugin);

const serverOptions = {
    port: 3000,
    host: '127.0.0.1'
};

await apiServer.listen(serverOptions);