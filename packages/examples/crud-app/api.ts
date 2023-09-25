import fastify from 'fastify';
import {CreateGatewayPlugin} from '@streamerson/gateway-fastify';
import {Events, streamTopic} from "./config";
import { Logger } from 'pino'

export async function bootstrapApi() {

    const appName = 'crud-app';

    const apiServer = fastify<any, any, any, Logger>({
        logger: true
    });

    apiServer.get('/', async () => {
        return {
            hello: 'world!'
        }
    });

    const streamPlugin = CreateGatewayPlugin({
        logger: apiServer.log,
        topic: streamTopic,
        routes: {
            method: 'GET',
            url: '/streamed',
            messageType: Events.HELLO_EVENT,
            timeout: 1000
        }
    });

    await apiServer.register(streamPlugin);

    const serverOptions = {
        port: 3000,
        host: '127.0.0.1'
    };

    await apiServer.listen(serverOptions);
}

bootstrapApi().catch(err => {
    console.error(err);
    process.exit(1);
});