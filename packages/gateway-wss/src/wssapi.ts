import Pino from 'pino';
import {App, HttpRequest, WebSocket} from 'uWebSockets.js';
import {
  ids,
  MappedStreamEvent,
  MessageType,
  NullablePrimitive,
  StreamersonLogger,
  StreamingDataSource,
  Topic
} from '@streamerson/core';

export { WebSocket };
// import { StreamConsumer } from '../state';
const moduleLogger = Pino({
    base: {
        module: 'stremerson_gateway_wss'
    },
});

export type StreamSocket = WebSocket<{}>;

export type WebsocketResponse = Record<string, NullablePrimitive>;
export class WebSocketServer<Response extends WebsocketResponse> {
    static deserializeWebsocketMessageToStreamEvent(message: ArrayBuffer, messageType: string, messageDestination?: string) {
        try {
            let uintArray = new DataView(message);
            let messageText = new TextDecoder("utf-8").decode(uintArray);
            const messageJson = JSON.parse(messageText);
            const { token } = messageJson;
            delete messageJson['token'];
            const userMessage: MappedStreamEvent = {
                payload: messageJson,
                messageDestination: messageDestination ?? '',
                messageId:ids.guuid(),
                messageType: (messageType ?? 'SOCKET') as MessageType,
                messageProtocol: 'json',
                messageSourceId: token
            };
            moduleLogger.info(userMessage, 'Received message from websocket');
            return userMessage;
        } catch (error) {
            moduleLogger.error(error, `Deserialization error in message: ${message.toString()}`);
            throw error;
        }
    }

    static deserializeStreamEventToWebsocketMessage<T extends WebsocketResponse>(message: MappedStreamEvent) {
        try {
            const { messageSourceId: token } = message;
            const response: WebsocketResponse = {
                ...message.payload,
                messageId: message.messageId
            };
            moduleLogger.info(response, 'Generated response for websocket');
            return {
                response,
                token
            };
        } catch (error) {
            moduleLogger.error(error, `Deserialization error in message: ${message.toString()}`);
            throw error;
        }
    }

    logger: StreamersonLogger;
    server: ReturnType<typeof App>;
    port: number;
    onMessage: (ws: StreamSocket, message: ArrayBuffer) => void;
    drained: Promise<void> | null;
    constructor(public options?: {
        server?: ReturnType<typeof App>,
        port?: number,
        logger?: StreamersonLogger,
        onMessage?: (ws: StreamSocket, message: ArrayBuffer) => void
    }) {
        this.logger = (options?.logger ?? moduleLogger) as any;
        this.server = options?.server ?? App({
            /* There are more SSL options, cut for brevity */
            // key_file_name: 'misc/key.pem',
            // cert_file_name: 'misc/cert.pem',
        });

        this.port = options?.port ?? 9001;

        this.onMessage = options?.onMessage ? options.onMessage.bind(this) : (message) => {
            moduleLogger.info(message);
        };

        this.drained = null;
    }

    async streamRoute(path: string, messageType: string, topic: Topic, options: {
        onMessage?: (ws: StreamSocket, message: MappedStreamEvent) => void | Promise<void>,
        onOpen?: (ws: StreamSocket) => void,
        onClose?: (ws: StreamSocket) => void,
        onPing?: (ws: StreamSocket) => void,
        onPong?: (ws: StreamSocket) => void,
        authenticate: (req: HttpRequest) => boolean | Promise<boolean>
    }) {
        const [read, write] = [new StreamingDataSource(), new StreamingDataSource()];

        await Promise.all([
            read.connect(),
            write.connect()
        ]);

        const outgoingStream = write.getWriteStream({
            topic
        });

        const incomingStream = write.getReadStream({
            topic
        });

        incomingStream.on('data', event=>{
            const { response, token } = WebSocketServer.deserializeStreamEventToWebsocketMessage(event);
            if (!this.server.numSubscribers(token)) {
                moduleLogger.warn({event}, 'WS Response Precheck: No subscribers for messageSourceId');
                return;
            }

            const published = this.server.publish(token, JSON.stringify(response));

            if (!published) {
                moduleLogger.warn({event}, 'WS Response Postcheck: No subscribers for token messageSourceId');
                return;
            }

            moduleLogger.info({token}, 'WS Response: Published message to subscribers');
        })

        this.server.ws(path, {
            /* There are many common helper features */
            idleTimeout: 36,
            maxBackpressure: 1024,
            maxPayloadLength: 512,
            /* For brevity we skip the other events (upgrade, open, ping, pong, close) */
            message: async (ws, message, isBinary) => {
                const streamEvent = WebSocketServer.deserializeWebsocketMessageToStreamEvent(message, messageType);
                const isSubscribed = ws.isSubscribed(streamEvent.messageSourceId);
                if (!isSubscribed) {
                    await ws.subscribe(streamEvent.messageSourceId);
                }
                const numSubscribed = this.server.numSubscribers(streamEvent.messageSourceId);

                if (numSubscribed > 1) {
                    moduleLogger.warn({streamEvent}, 'WS Message: Multiple subscribers for messageSourceId');
                }

                if (options.onMessage) {
                    await options.onMessage(ws, streamEvent);
                }

                await this.drained;
                const written = outgoingStream.write(streamEvent);
                if (!written) {
                    this.drained ||= new Promise((resolve, reject)=>{
                        outgoingStream.once('drain', ()=>{
                            this.drained = null;
                            resolve();
                        });
                    });
                }
            },
            close: options.onClose,
            ping: options.onPing,
            pong: options.onPong,
            open: options.onOpen,
            upgrade: async (res, req, context) => {
                const auth = await options.authenticate(req);
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

    async listen() {
        await new Promise<void>((resolve, reject)=>{
            try {
                this.server.listen(this.port, (listenSocket) => {
                    if (listenSocket) {
                        moduleLogger.info('Listening to port 9001');
                    }
                });
                resolve();
            } catch(err) {
                reject(err);
            }
        })
    }
}
