import Redis from 'ioredis';
import pino from 'pino';
import {type DataSourceOptions, type ConnectableDataSource, StreamersonLogger} from '../../types';

export class RedisDataSource implements ConnectableDataSource {
	public _client: Redis | undefined = undefined;
	public _control: Redis | undefined = undefined;
	private clientId: number | undefined;
	public logger: StreamersonLogger;
	constructor(
		public options: DataSourceOptions = {
			port: 6379,
			host: 'localhost',
			controllable: true,
			logger: pino({
				base: {
					module: 'streamerson_sdk_datasource',
				}
			}),
		},
	) {
		this.logger = options.logger
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
		this.client.disconnect();
		if (this.options.controllable) {
			this.control.disconnect();
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
			this._client = new Redis(this.options.port, this.options.host, {
				retryStrategy: undefined,
			});
			if (this.options.controllable) {
				this._control = new Redis(this.options.port, this.options.host, {
					retryStrategy: undefined,
				});
			}
		}

		const connectionPromise = new Promise<RedisDataSource>(
			(resolve, reject) => {
				this.client.on('end', (error: Error | unknown) => {
					this.options.logger.error(error);
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
						resolve(this);
					} catch (err) {
						reject(err);
					}
				});
			},
		);

		if (this.options.controllable) {
			const controlPromise = new Promise<RedisDataSource>((resolve, reject) => {
				this.control.on('end', (error: Error | unknown) => {
					this.options.logger.error(error);
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
						resolve(this);
					} catch (err) {
						reject(err);
					}
				});
			});
			return Promise.all([connectionPromise, controlPromise]).then(() => this);
		}

		return connectionPromise;
	}
}
