import {WebSocketServer} from '@streamerson/gateway-wss';
import {Topic} from "@streamerson/core";

export enum Events {
    HELLO_EVENT = 'hello'
}

export const streamTopic = new Topic('my-stream-topic');

const wssServer = new WebSocketServer({
    port: 3000
});

await wssServer.streamRoute('/hello', Events.HELLO_EVENT, streamTopic, {
    authenticate: () => {
        return true;
    }
});

await wssServer.listen();