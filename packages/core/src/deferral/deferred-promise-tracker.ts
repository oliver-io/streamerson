import {EventEmitter} from 'events';
import { type MappedStreamEvent, StreamersonLogger } from '../types';

export const DEFAULT_TIMEOUT = 3000;

function noOpFunction():void{ void 0; }

type ResponseTracker<T = any> = {
	self: Promise<T>;
	resolve: (t: T)=>void;
	reject: (e: Error | unknown)=>void;
	timeout: NodeJS.Timeout | undefined;
};

export type DeferralTrackerOptions = {
	timeout?: number;
	logger?: StreamersonLogger;
} & ConstructorParameters<
  typeof EventEmitter
>[0];

type DeferredEvent<T = Record<string, any>> = {
	messageId: string;
} & T;

/*
    When we dispatch a message, we want to await a promise that doesn't exist yet.  I.E., there is an event that will
    occur on the stream at a later time, and we want to syntactically await that event.  We could in theory structure
    this as a `this.once(id, ...)` call, but that essentially strands a bunch of handlers around town and limits our
    ability to do things like cancel.  So instead, we'll roll our own promise tracker, which can generate a promise
    bound to the emitter emitting a specific event in the future, such that we can do something like:

        const id = outStream.dispatch(event);
        const response = await inStream.promise(id);
 */
export class DeferralTracker extends EventEmitter {
	staticTimeoutError: Error;
	timeout: number;
	promises: Record<string, ResponseTracker> = {};
	logger: StreamersonLogger;
	constructor(args: DeferralTrackerOptions = {}) {
		super(args);
		this.addListener('response', this.responseEvent.bind(this));
		this.addListener('error', this.errorEvent.bind(this));
		this.timeout = args.timeout ?? DEFAULT_TIMEOUT;
		this.staticTimeoutError = new Error(
			`Request timed out after ${this.timeout / 1000} seconds`,
		);
		this.logger = args.logger ?? console as Console;
	}

	responseEvent(event: MappedStreamEvent) {
		try {
			const {messageId} = event;
			if (this.promises[messageId]) {
				// Happy Path: the message was pending
				this.promises[messageId].resolve(event);
				if (this.promises[messageId].timeout) {
					clearTimeout(this.promises[messageId].timeout);
				}
			} else {
				// Less happy path: we hear a response before deferral:
				// -- avoid Racies:
				this.promises[messageId] = {
					self: Promise.resolve(event),
					resolve: noOpFunction,
					reject: noOpFunction,
					timeout: setTimeout(() => {
							delete this.promises[messageId];
						}, this.timeout * 2),
				};
			}
		} catch (err) {
			this.errorEvent({
				...event,
				payload: {
					message: 'INTERNAL_SERVER_ERROR',
				},
			});
		}
	}

	cancelAll(message?: string) {
		for (const id in this.promises) {
			this.cancel(id, message);
		}
	}

	cancel(id: string, message?: string) {
		if (this.promises[id]) {
			if (this.promises[id].timeout) {
				clearTimeout(this.promises[id].timeout);
			} else {
				console.log('CANNOT FIND TIMEOUT TO CLEAR');
			}

			this.promises[id].reject(
				new Error(`CANCELLED${message ? `: ${message}` : ''}`),
			);

			this.delete(id);
		}
	}

	errorEvent(event: MappedStreamEvent) {
		const {messageId} = event;
		if (this.promises[messageId]) {
			// Less But Still Happy Path:
			this.promises[messageId].reject(event);
			if (this.promises[messageId].timeout) {
				clearTimeout(this.promises[messageId].timeout);
			}
		} else {
			// Still avoid racies
			this.promises[messageId] = {
				self: Promise.reject(event),
				resolve: noOpFunction,
				reject: noOpFunction,
				timeout: setTimeout(() => {
					delete this.promises[messageId];
				}, this.timeout * 2),
			};
		}

    this.logger.error(event);
	}

	async promise<T extends DeferredEvent>(
		id: string,
	): Promise<DeferredEvent<T>> {
		/* OPTME: There is a tradeoff here regarding a certain quantity
        ** of hanging promises; the sheer number of possibly pending
        ** Promise objects could weigh on both the event loop and
        ** memory pool.

        ** However, the obvious alternative to this jank (`this.once(id, ...)`)
        ** implies the existence of an absolute fuckton of lambda functions
        ** registered anonymously in memory, each one of which will be a
        ** closure that I'm not sure I want to keep in memory either.  So we
        ** start here:

        ** The other obvious option (a WeakMap) brings in a lot of indeterminate
        ** garbage collection -- I'm not entirely sure when the GC engine will
        ** determine that a promise cannot be referenced any longer, due to the
        ** fact that our wrapper objects contain a direct reference that will not
        ** be garbage collected by default.  So instead, for now, let's just
        ** roll it ourselves, bb.
        */

		if (this.promises[id] !== undefined) {
			return this.promises[id].self;
		}

		let resolve: (t: T)=>void | undefined = noOpFunction;
		let reject: (e: Error | unknown)=>void | undefined = noOpFunction;
		const promise = new Promise<T>((resolver, rejecter) => {
			resolve = resolver;
			reject = rejecter;
		});

		this.promises[id] = {
			self: promise,
			resolve,
			reject,
			timeout: global.setTimeout(() => reject!(this.staticTimeoutError), this.timeout) as unknown as NodeJS.Timeout,
		};

		return this.promises[id].self as Promise<T>;
	}

	delete(id: string) {
		delete this.promises[id];
	}
}
