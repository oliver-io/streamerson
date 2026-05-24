import { RedisClient } from 'bun';
import { type DataSourceOptions, type ConnectableDataSource, StreamersonLogger } from '../../types';
import { environmentValueFor } from '../../utils/environment';
import { createStreamersonLogger } from '../../utils/logger';

const DEFAULT_PORT = parseInt(environmentValueFor('STREAMERSON_REDIS_PORT'));
const DEFAULT_HOST = environmentValueFor('STREAMERSON_REDIS_HOST');

const moduleLogger = createStreamersonLogger({
  module: 'datasource',
});

/**
 * Base Redis connection wrapper over Bun's native `RedisClient`.
 *
 * Owns a primary data connection and, when `controllable`, a separate `control`
 * connection used for out-of-band commands (e.g. XACK) while the data
 * connection is parked in a blocking read. Stream commands are issued via
 * `client.send(...)` in the StreamingDataSource subclass — Bun's client has no
 * typed Streams API, so we drive streams through the raw command escape hatch.
 */
export class RedisDataSource implements ConnectableDataSource {
  public _client: RedisClient | undefined = undefined;
  public _control: RedisClient | undefined = undefined;
  public logger: StreamersonLogger;
  protected closing = false;

  constructor(
    public options: DataSourceOptions = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      controllable: true,
      logger: moduleLogger,
    },
  ) {
    this.logger = options.logger ?? moduleLogger;
  }

  private redisUrl() {
    const host = this.options.host ?? DEFAULT_HOST ?? 'localhost';
    const port = this.options.port ?? (Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 6379);
    return `redis://${host}:${port}`;
  }

  private make(): RedisClient {
    return this.options.getConnection
      ? this.options.getConnection()
      : new RedisClient(this.redisUrl(), { idleTimeout: 0 });
  }

  get client() {
    if (!this._client) {
      throw new Error('StreamingDataSource client called before initialization');
    }
    return this._client;
  }

  get control() {
    if (!this.options.controllable || !this._control) {
      throw new Error('Error getting control connection');
    }
    return this._control;
  }

  /** True once `disconnect()` has begun — lets read loops exit instead of spinning. */
  get isClosing(): boolean {
    return this.closing;
  }

  async debugPing() {
    return this.client.send('PING', []);
  }

  /**
   * No-op: blocking reads are bounded by a short BLOCK timeout (see
   * StreamingDataSource), so there is no parked connection to forcibly unblock.
   */
  async abort(_error?: boolean) {}

  async disconnect() {
    this.closing = true;
    // Stop any read loop (subclasses override abort to cancel iteration) before
    // closing, so an interrupted read isn't reported as an error.
    await this.abort();
    // Closing is best-effort and non-blocking: Bun's close() can return a
    // promise that settles late when a connection is parked in a blocking read,
    // so we fire it and swallow any (sync or async) "Connection closed" rejection.
    this.safeClose(this._control);
    this._control = undefined;
    this.safeClose(this._client);
    this._client = undefined;
  }

  private safeClose(connection?: RedisClient) {
    try {
      const closed = connection?.close() as unknown;
      if (closed && typeof (closed as { catch?: unknown }).catch === 'function') {
        (closed as Promise<unknown>).catch(() => { /* intentional close */ });
      }
    } catch { /* intentional close */ }
  }

  async connect() {
    this._client = this.make();
    this._client.onclose = (err: unknown) => { if (!this.closing) this.logger.error(err, 'Remote data connection closed'); };
    await this._client.connect();
    if ((await this._client.send('PING', [])) !== 'PONG') {
      throw new Error('Connection established but unable to complete PINGPONG');
    }

    if (this.options.controllable) {
      this._control = this.make();
      this._control.onclose = (err: unknown) => { if (!this.closing) this.logger.error(err, 'Remote control connection closed'); };
      await this._control.connect();
      if ((await this._control.send('PING', [])) !== 'PONG') {
        throw new Error('Control connection established but unable to complete PINGPONG');
      }
    }

    return this;
  }
}
