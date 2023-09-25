import Pino from 'pino';
import { v4 as uuid } from 'uuid';
import { App, HttpRequest, WebSocket } from 'uWebSockets.js';
import { MappedStreamEvent, MessageType } from '@streamerson/core';
export { WebSocket };
// import { StreamConsumer } from '../state';
const moduleLogger = Pino({
    base: {
        module: 'wss_api'
    },
    transport: {
        target: 'pino-pretty'
    },
});

// const streamStateMachine = new StreamConsumer<{
//     playerBindings: Record<string, string>
// }>({
//     logger: moduleLogger,
//     ingestionSource: 'wss',
//     meta: {
//         mode: StreamMessageFlowModes.REALTIME,
//         namespace: 'WSS',
//         sharded: false
//     },
//     stateConfigurations: {
//         playerBindings: {
//             type: StateObjectTypes.CollectionHash,
//             replicated: true,
//             owner: true,
//         }
//     }
// });

export type StreamSocket = WebSocket<{}>;

export class WebSocketServer {
    static deserializeMessageToStreamEvent(message: ArrayBuffer, ) {
        try {
            //     /* You can do app.publish('sensors/home/temperature', '22C') kind of pub/sub as well */
            let uintArray = new DataView(message);
            let messageText = new TextDecoder("utf-8").decode(uintArray);
            const messageJson = JSON.parse(messageText);
            const { token } = messageJson;
            delete messageJson['token'];
            const userMessage: MappedStreamEvent = {
                payload: JSON.parse(messageText),
                messageDestination: '',
                messageId:ids.guuid(),
                messageType: 'SOCKET' as MessageType.SOCKET,
                messageProtocol: 'json',
                messageSourceId: token
            };
            moduleLogger.info(userMessage, 'Received message from player');
            return userMessage;
        } catch (error) {
            moduleLogger.error(error, `Deserialization error in message: ${message.toString()}`);
            throw error;
        }
    }

    logger: Pino.Logger;
    server: ReturnType<typeof App>;
    port: number;
    onMessage: (ws: StreamSocket, message: ArrayBuffer) => void;
    constructor(public options?: {
        server?: ReturnType<typeof App>,
        port?: number,
        logger?: Pino.Logger,
        onMessage?: (ws: StreamSocket, message: ArrayBuffer) => void,
    }) {
        this.logger = options?.logger ?? moduleLogger;
        this.server = options?.server ?? App({
            /* There are more SSL options, cut for brevity */
            // key_file_name: 'misc/key.pem',
            // cert_file_name: 'misc/cert.pem',
        });

        this.port = options?.port ?? 9001;

        this.onMessage = options?.onMessage ? options.onMessage.bind(this) : (message) => {
            moduleLogger.info(message);
        };
    }

    addRoute(path: string, options: { 
        onMessage: (ws: StreamSocket, message: MappedStreamEvent) => void,
        onOpen?: (ws: StreamSocket) => void,
        onClose?: (ws: StreamSocket) => void,
        onPing?: (ws: StreamSocket) => void,
        onPong?: (ws: StreamSocket) => void,
        authenticate: (req: HttpRequest) => boolean,
    }) {
        this.server.ws(path, {
            /* There are many common helper features */
            idleTimeout: 36,
            maxBackpressure: 1024,
            maxPayloadLength: 512,
            /* For brevity we skip the other events (upgrade, open, ping, pong, close) */
            message: (ws, message, isBinary) => options.onMessage(ws, WebSocketServer.deserializeMessageToStreamEvent(message)),
            open: options.onOpen,
            close: options.onClose,
            ping: options.onPing,
            pong: options.onPong,
            upgrade: (res, req, context) => {
                const auth = options.authenticate(req);
                if (!auth) {
                    res.writeStatus('401 Unauthorized');
                    res.end();
                    return;
                }

                res.upgrade(
                    {}, 
                    req.getHeader('sec-websocket-key'), 
                    req.getHeader('sec-websocket-protocol'), 
                    req.getHeader('sec-websocket-extensions'), 
                    context
                );
            },
        });
    }

    listen() {
        this.server.listen(this.port, (listenSocket) => {
            if (listenSocket) {
                moduleLogger.info('Listening to port 9001');
            }
        });
    }
}