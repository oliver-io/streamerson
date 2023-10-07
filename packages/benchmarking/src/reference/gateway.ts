import fastify from 'fastify';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import {StreamersonLogger, Topic} from "@streamerson/core";
import { config } from './config';
export enum Events {
    HELLO = 'hello'
}
export const streamTopic = new Topic(config.topic);

async function main() {

    const apiServer = fastify<any, any, any, Exclude<StreamersonLogger, typeof console>>({
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
        port: config.port,
        host: config.host
    };

    await apiServer.listen(serverOptions);
}

main().catch((err: any)=> { console.error(err); throw err; });