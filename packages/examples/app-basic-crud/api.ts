import fastify from 'fastify';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import {StreamersonLogger, Topic} from "@streamerson/core";

export enum Events {
    CREATE = 'create',
    READ = 'read',
    UPDATE = 'update',
    DELETE = 'delete'
}

export const streamTopic = new Topic('my-stream-topic');

const apiServer = fastify<any, any, any, Exclude<StreamersonLogger, typeof console>>({
    logger: true
});

const streamPlugin = CreateGatewayPlugin({
    logger: apiServer.log,
    topic: streamTopic,
    routes: [
        {
            method: 'POST',
            url: '/data',
            messageType: Events.CREATE
        },
        {
            method: 'GET',
            url: '/data',
            messageType: Events.READ
        },
        {
            method: 'PUT',
            url: '/data',
            messageType: Events.UPDATE
        },
        {
            method: 'DELETE',
            url: '/data',
            messageType: Events.DELETE
        }
    ]
});

await apiServer.register(streamPlugin);

const serverOptions = {
    port: 3000,
    host: '127.0.0.1'
};

await apiServer.listen(serverOptions);