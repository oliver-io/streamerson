import { createClient, RedisClientType as Redis } from 'redis';
import {type DataSourceOptions, type ConnectableDataSource, StreamersonLogger} from '../../types';
import {environmentValueFor} from "../../utils/environment";
import {createStreamersonLogger} from "../../utils/logger";
import { ClientKillFilters } from '@redis/client/dist/lib/commands/CLIENT_KILL';

process.env['LOG_LEVEL'] = 'debug'
process.env['PINO_LOG_LEVEL'] = 'debug';

const DEFAULT_PORT = parseInt(environmentValueFor('STREAMERSON_REDIS_PORT'));
const DEFAULT_HOST = environmentValueFor('STREAMERSON_REDIS_HOST')

const moduleLogger = createStreamersonLogger({
  module: 'datasource'
});

export class RedisDataSource implements ConnectableDataSource {
  public _client: Redis | undefined = undefined;
  public _control: Redis | undefined = undefined;
  private clientId: number | undefined;
  public logger: StreamersonLogger;

  constructor(
    public options: DataSourceOptions = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      controllable: true,
      logger: moduleLogger,
    },
  ) {
    this.logger = options.logger ?? moduleLogger
    // Hack: DragonflyDB does not support CLIENT INFO
    this.options.controllable = false;
  }

  async debugPing() {
    return this.client.ping();
  }

  get client() {
    if (!this._client) {
      throw new Error(
        'StreamingDataSource client called before initialization',
      );
    }

    return this._client;
  }

  get control() {
    if (!this.options.controllable || !this._control) {
      throw new Error('Error getting control connection');
    }

    return this._control;
  }

  async abort(error?: boolean) {
    if (this._control && this.clientId) {
      // await this._client?.clientKill({
      //   id: this.clientId
      // });
    } /*else {
      throw new Error(
        `Cannot abort a non-controllable connection (controllable=${this.options.controllable}, clientId=${this.clientId})`,
      );
    }*/
  }

  async disconnect() {
    if (this.options.controllable) {
      await this.abort();
      await this.control.disconnect();
      this._control = undefined;
    }
    await this.client.disconnect();
    this._client = undefined;
  }

  retry(times: number) {
    if (times < 3) {
      return 5000;
    } else {
      return false;
    }
  }

  dataError(error: Error | string | null, clientContext: string) {
    const message = 'Redis data connection emitted unhandled error';
    if (error) {
      if (typeof error === 'string') {
        this.logger.error({
          message: error
        }, message);
      } else {
        this.logger.error(error, message);
      }
    } else {
      this.logger.error({
        message: 'Unknown error from data connection'
      }, message);
    }
  }

  controlError(error: Error | string | null, clientContext: string) {
    const message = 'Redis control connection emitted unhandled error';
    if (error) {
      if (typeof error === 'string') {
        this.logger.error({
          message: error
        }, message);
      } else {
        this.logger.error(error, message);
      }
    } else {
      this.logger.error({
        message: 'Unknown error from control connection'
      }, message);
    }
  }

  async connect() {
    if (this.options.getConnection) {
      // Multiple wrappers perhaps using one connection:
      this._client = this.options.getConnection();
      if (this.options.controllable) {
        // Multiple wrappers perhaps using one connection:
        this._control = this.options.getConnection();
      }
    } else {
      this._client = createClient({
        // port: this.options.port ?? DEFAULT_PORT,
        url: this.options.host ?? DEFAULT_HOST,
        socket: {
          reconnectStrategy: this.retry.bind(this)
        },

      });
      if (this.options.controllable) {
        this._control = createClient({
          // port: this.options.port ?? DEFAULT_PORT,
          url: this.options.host ?? DEFAULT_HOST,
          socket: {
            reconnectStrategy: this.retry.bind(this)
          },
        });
      }
    }

    const connectionPromise = new Promise<void>(
      (resolve, reject) => {
        this.logger.info('Connecting data channel to Redis...');
        this.client.on('error', this.dataError.bind(this));
        this.client.on('end', (error: Error | unknown) => {
          this.logger.error(error, 'Remote connection ended...');
        });
        this.client.on('connect', async () => {
          try {
            const pong = await this.client.ping();
            if (pong !== 'PONG') {
              throw new Error(
                'Connection established but unable to complete PINGPONG',
              );
            }

            // this.clientId = await this.client.client('ID');
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    let controlPromise: Promise<void> | undefined;

    if (this.options.controllable) {
      controlPromise = new Promise<void>((resolve, reject) => {
        this.logger.info('Connecting control channel to Redis...');
        this.control.on('error', this.controlError.bind(this));
        this.control.on('end', (error: Error | unknown) => {
          this.logger.error(error, 'Control connection ended...');
        });
        this.control.on('connect', async () => {
          try {
            const pong = await this.control.ping();
            if (pong !== 'PONG') {
              throw new Error(
                'Control connection established but unable to complete PINGPONG',
              );
            }

            // This.controlClientId = await this.control.client('ID');
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    }

    await Promise.all([connectionPromise, controlPromise]);
    return this;
  }
}
