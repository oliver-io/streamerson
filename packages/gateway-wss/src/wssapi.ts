import type { Server, ServerWebSocket } from 'bun';
import {
  createStreamersonLogger,
  ids,
  MappedStreamEvent,
  MessageType,
  NullablePrimitive,
  StreamersonLogger,
  StreamingDataSource,
  Topic,
} from '@streamerson/core';

const moduleLogger = createStreamersonLogger({ module: 'streamerson_gateway_wss' });

export type WebsocketResponse = Record<string, NullablePrimitive>;

/** Per-socket data attached at upgrade so the shared handlers can route by path. */
type SocketData = { path: string };
export type StreamSocket = ServerWebSocket<SocketData>;

export type StreamRouteOptions = {
  onMessage?: (ws: StreamSocket, message: MappedStreamEvent) => void | Promise<void>;
  onOpen?: (ws: StreamSocket) => void;
  onClose?: (ws: StreamSocket) => void;
  authenticate: (req: Request) => boolean | Promise<boolean>;
};

type RouteConfig = {
  messageType: string;
  topic: Topic;
  outgoingStream: ReturnType<StreamingDataSource['getWriteStream']>;
  options: StreamRouteOptions;
};

/**
 * WebSocket gateway over Bun's native `Bun.serve` (uWebSockets compiled into
 * Bun — no native addon). Bun.serve exposes a single `websocket` handler, so
 * routes are registered up front and dispatched by `ws.data.path`; the upgrade
 * + auth happens in `fetch`. Each route bridges a WS path to a stream Topic and
 * publishes responses back to the originating socket by its source token.
 */
export class WebSocketServer {
  static deserializeWebsocketMessageToStreamEvent(
    message: string | Buffer,
    messageType: string,
    messageDestination?: string,
  ): MappedStreamEvent {
    try {
      const messageText = typeof message === 'string' ? message : new TextDecoder('utf-8').decode(message);
      const messageJson = JSON.parse(messageText);
      const { token } = messageJson;
      delete messageJson['token'];
      const userMessage: MappedStreamEvent = {
        payload: messageJson,
        messageDestination: messageDestination ?? '',
        messageId: ids.guuid(),
        messageType: (messageType ?? 'SOCKET') as MessageType,
        messageProtocol: 'json',
        messageSourceId: token,
      };
      moduleLogger.info(userMessage, 'Received message from websocket');
      return userMessage;
    } catch (error) {
      moduleLogger.error(error, 'Deserialization error in websocket message');
      throw error;
    }
  }

  static deserializeStreamEventToWebsocketMessage(message: MappedStreamEvent) {
    const { messageSourceId: token } = message;
    const response: WebsocketResponse = {
      ...message.payload,
      messageId: message.messageId,
    };
    return { response, token };
  }

  logger: StreamersonLogger;
  port: number;
  server?: Server<SocketData>;
  private routes = new Map<string, RouteConfig>();

  constructor(public options?: { port?: number; logger?: StreamersonLogger }) {
    this.logger = options?.logger ?? moduleLogger;
    this.port = options?.port ?? 9001;
  }

  /**
   * Register a WS path that bridges to a stream Topic. Connects the channels and
   * starts forwarding responses (read from the topic's loopback/producer end)
   * back to the subscribed socket keyed by its source token.
   */
  async streamRoute(path: string, messageType: string, topic: Topic, options: StreamRouteOptions) {
    const write = new StreamingDataSource();
    await write.connect();

    const outgoingStream = write.getWriteStream({ topic });
    const incomingStream = write.getReadStream({ topic: topic.loopback() });

    incomingStream.on('data', (event: MappedStreamEvent) => {
      const { response, token } = WebSocketServer.deserializeStreamEventToWebsocketMessage(event);
      if (!token || !this.server) {
        return;
      }
      if (!this.server.subscriberCount(token)) {
        this.logger.warn({ token }, 'WS response: no subscribers for source token');
        return;
      }
      this.server.publish(token, JSON.stringify(response));
    });

    this.routes.set(path, { messageType, topic, outgoingStream, options });
  }

  async listen() {
    const routes = this.routes;
    const logger = this.logger;

    this.server = Bun.serve<SocketData>({
      port: this.port,
      async fetch(req, server) {
        const { pathname } = new URL(req.url);
        const route = routes.get(pathname);
        if (!route) {
          return new Response('Not found', { status: 404 });
        }
        if (!(await route.options.authenticate(req))) {
          return new Response('Unauthorized', { status: 401 });
        }
        if (server.upgrade(req, { data: { path: pathname } })) {
          return undefined; // handshake completed
        }
        return new Response('WebSocket upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          routes.get(ws.data.path)?.options.onOpen?.(ws);
        },
        close(ws) {
          routes.get(ws.data.path)?.options.onClose?.(ws);
        },
        async message(ws, message) {
          const route = routes.get(ws.data.path);
          if (!route) {
            return;
          }
          const streamEvent = WebSocketServer.deserializeWebsocketMessageToStreamEvent(message, route.messageType);
          if (!ws.isSubscribed(streamEvent.messageSourceId)) {
            ws.subscribe(streamEvent.messageSourceId);
          }
          await route.options.onMessage?.(ws, streamEvent);
          route.outgoingStream.write(streamEvent);
        },
      },
    });

    logger.info(`Streamerson WSS gateway listening on ${this.port}`);
  }

  stop() {
    this.server?.stop();
  }
}
