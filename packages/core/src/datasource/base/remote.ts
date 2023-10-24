import Redis from 'ioredis';
import pino from 'pino';
import {type DataSourceOptions, type ConnectableDataSource, StreamersonLogger} from '../../types';
import { environmentValueFor } from "../../utils/environment";

const DEFAULT_PORT = parseInt(environmentValueFor('STREAMERSON_REDIS_PORT'));
const DEFAULT_HOST = environmentValueFor('STREAMERSON_REDIS_HOST')

const moduleLogger = pino({
  base: {
    module: 'stream_consumer'
  },
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
			await this._control.call(
				'CLIENT',
				'UNBLOCK',
				this.clientId,
				error ? 'ERROR' : 'TIMEOUT',
			);
		} else {
			throw new Error(
				`Cannot abort a non-controllable connection (controllable=${this.options.controllable}, clientId=${this.clientId})`,
			);
		}
	}

	async disconnect() {
		if (this.options.controllable) {
			await this.abort();
			this.control.disconnect();
			this._control = undefined;
		}
		this.client.disconnect();
		this._client = undefined;
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
			this._client = new Redis(this.options.port ?? DEFAULT_PORT, this.options.host ?? DEFAULT_HOST, {
				retryStrategy: undefined,
			});
			if (this.options.controllable) {
				this._control = new Redis(this.options.port ?? DEFAULT_PORT, this.options.host ?? DEFAULT_HOST, {
					retryStrategy: undefined,
				});
			}
		}

		const connectionPromise = new Promise<>(
			(resolve, reject) => {
				this.client.on('end', (error: Error | unknown) => {
					this.logger.warn(error);
				});
				this.client.on('connect', async () => {
					try {
						const pong = await this.client.ping();
						if (pong !== 'PONG') {
							throw new Error(
								'Connection established but unable to complete PINGPONG',
							);
						}

						this.clientId = await this.client.client('ID');
						resolve();
					} catch (err) {
						reject(err);
					}
				});
			},
		);

		let controlPromise:Promise<void> | undefined;

		if (this.options.controllable) {
			controlPromise = new Promise<void>((resolve, reject) => {
				this.control.on('end', (error: Error | unknown) => {
					this.logger.error(error);
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
