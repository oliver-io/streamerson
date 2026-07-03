import { DeferralTracker, StreamersonLogger } from '..';
import { type MappedStreamEvent, type MessageType, type StreamConfiguration } from '../types';
import { ids } from '../utils/ids';
import { shardDecorator } from '../utils/keys';

/**
 * Response-reader reconnect policy (the awaiter owns it; the datasource only exposes the
 * transport `reconnect()`). Defaults: reconnect forever, freezing in-flight requests for the
 * whole outage. Set `maxAttempts` to give up after N consecutive failed attempts (counted
 * since the last successful delivery) and fail pending requests (→ 503 at the gateway).
 * See docs/specs/GATEWAY_READER_SELF_HEAL.md.
 */
export type ReconnectOptions = {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  maxAttempts?: number;
};

type DispatchOptions = {
  /** Client-disconnect cancellation: aborting cancels the deferral (the gateway wires the HTTP request's close). */
  signal?: AbortSignal;
  /** Per-call timeout override (e.g. a per-route timeout); falls back to the awaiter default. */
  timeout?: number;
};

type streamAwaiterOptions = Omit<StreamConfiguration, 'outgoingStream'> & {
  logger?: StreamersonLogger;
  outgoingStream?: string;
  timeout?: number;
  concurrency?: number;
  reconnect?: ReconnectOptions;
};

export const streamAwaiter = <T extends MappedStreamEvent>(
  options: streamAwaiterOptions
) => {
  const stateTracker = new DeferralTracker(options);
  const { outgoingStream, incomingStream, writeChannel, readChannel } = options;
  const log = (options.logger ?? console) as StreamersonLogger;

  const rc = options.reconnect ?? {};
  const RC_BASE = rc.baseMs ?? 100;
  const RC_MAX = rc.maxMs ?? 5000;
  const RC_FACTOR = rc.factor ?? 2;
  const RC_MAXATTEMPTS = rc.maxAttempts; // undefined = reconnect forever

  return {
    stateTracker,
    async dispatch(
      message: string,
      messageType: MessageType,
      messageSourceId?: string,
      shard?: string,
      outgoingStreamOverride?: string,
      opts?: DispatchOptions
    ) {
      const target = outgoingStream ?? outgoingStreamOverride;
      if (!target) {
        throw new Error(
          'Either a configured or override stream target must be provided'
        );
      }
      // Client already gone before we start — don't bother enqueuing.
      const signal = opts?.signal;
      if (signal?.aborted) {
        throw new Error('CANCELLED: client disconnected');
      }

      const id = ids.guuid();
      const $expectedResponse = stateTracker.promise<T>(id, opts?.timeout);

      // Client-disconnect cancellation (R8): RACE the response against the request's abort
      // signal rather than rejecting the deferral directly. If we rejected the deferral, a
      // disconnect during the write window (before we `await $expectedResponse`) would leave it
      // rejected-but-unobserved — a transient unhandled rejection. Instead the deferral is
      // simply abandoned (deleted below); only `$aborted` carries the rejection, and it is
      // pre-observed so it can never go unhandled.
      let onAbort: (() => void) | undefined;
      const $aborted = signal
        ? new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('CANCELLED: client disconnected'));
            signal.addEventListener('abort', onAbort, { once: true });
          })
        : undefined;
      $aborted?.catch(() => { /* observed via the race below; swallow if the race settles first */ });

      // Remove the tracker entry (and its armed timeout) on EVERY outcome — success, a
      // dispatch timeout, an abort, or a writeToStream failure. Deleting only on success leaks
      // the promise-map entry on every rejection (a gateway under timeout load grows unbounded).
      try {
        await writeChannel.writeToStream({
          outgoingStream: target,
          incomingStream,
          messageType,
          messageId: id,
          message,
          sourceId: messageSourceId ?? '',
          shard
        });
        const deferredResponse = await ($aborted ? Promise.race([$expectedResponse, $aborted]) : $expectedResponse);
        return deferredResponse!.payload;
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        stateTracker.delete(id);
      }
    },

    /**
     * Begin routing producer-stream responses into the deferral tracker, and keep that reader
     * alive across transient Redis outages (self-heal). Returns an **awaitable** disposer.
     *
     * Cursor (Q9/GW15): seeds from a captured tip (not `'$'`) and resumes a re-arm from the
     * last *delivered* entry id — so the arm-up window and the whole outage backlog are read,
     * never skipped, and nothing is delivered twice.
     *
     * On a non-intentional read error: suspend in-flight deferral timers ("freeze time"),
     * reconnect with capped backoff, re-arm from the retained cursor, then resume. With
     * `reconnect.maxAttempts` set, give up after the cap and fail pending requests. The
     * disposer stops an in-progress reconnect, awaits the loop's exit, then detaches the
     * reader and aborts the read loop (the caller disconnects the channel AFTER it resolves —
     * R4/§7). See docs/specs/GATEWAY_READER_SELF_HEAL.md.
     */
    async readResponseStream(shard?: string): Promise<() => Promise<void>> {
      let disposed = false;
      let healing = false;
      let attempts = 0;
      let healPromise: Promise<void> | undefined;
      let wakeBackoff: (() => void) | undefined;
      let currentDetach: (() => void) | undefined;

      // Loss-free "from now" seed (tolerant: '0' on an unconnected channel).
      let lastCursor = await readChannel.currentTopId(incomingStream, shard);

      const arm = () => {
        const stream = readChannel.getReadStream({
          stream: shardDecorator({ key: incomingStream, shard }),
          last: lastCursor,
        });
        const onData = (e: T) => {
          stateTracker.emit('response', e);
          // Commit the cursor AFTER delivery: a re-arm resumes strictly after the last
          // delivered entry (no duplicate); the backlog (id > lastCursor) is re-read (no loss).
          const sid = (e as { streamMessageId?: string }).streamMessageId;
          if (sid) lastCursor = sid;
          attempts = 0; // a real delivery proves the connection healthy (R10)
        };
        const onError = (err: unknown) => {
          currentDetach?.();
          void beginHealing(err);
        };
        stream.on('data', onData);
        stream.on('error', onError);
        currentDetach = () => {
          stream.off('data', onData);
          stream.off('error', onError);
          currentDetach = undefined;
        };
      };

      const backoffMs = (n: number) => Math.min(RC_MAX, RC_BASE * Math.pow(RC_FACTOR, Math.max(0, n - 1)));

      const beginHealing = (err: unknown) => {
        if (disposed || healing) return;
        healing = true;
        log.error(err, 'streamAwaiter: response reader failed; suspending timeouts and reconnecting');
        stateTracker.suspendTimeouts();
        healPromise = (async () => {
          try {
            while (!disposed) {
              if (RC_MAXATTEMPTS != null && attempts >= RC_MAXATTEMPTS) {
                log.error('streamAwaiter: reconnect attempts exhausted; failing pending requests');
                stateTracker.cancelAll('reader unavailable');
                stateTracker.resumeTimeouts(); // un-suspend so any future requests get normal timeouts
                return;
              }
              attempts++;
              // Interruptible backoff: dispose wakes it so teardown is prompt.
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, backoffMs(attempts));
                wakeBackoff = () => { clearTimeout(t); resolve(); };
              });
              wakeBackoff = undefined;
              if (disposed) return;
              try {
                await readChannel.reconnect();
                if (disposed) return;
                arm();
                stateTracker.resumeTimeouts();
                return; // recovered
              } catch (e) {
                log.warn(e, 'streamAwaiter: reconnect attempt failed; backing off');
              }
            }
          } finally {
            healing = false;
          }
        })();
      };

      arm(); // initial reader

      return async () => {
        disposed = true;
        if (wakeBackoff) wakeBackoff();
        if (healPromise) { try { await healPromise; } catch { /* */ } }
        currentDetach?.();
        void readChannel.abort();
      };
    }
  };
};

/**
 * Class form of {@link streamAwaiter}. A thin delegate over the factory so the reconnect /
 * cursor / freeze logic lives in exactly one place.
 */
export class StreamAwaiter<T extends MappedStreamEvent> implements streamAwaiterOptions {
  public stateTracker: DeferralTracker;
  outgoingStream;
  incomingStream;
  writeChannel;
  readChannel;
  private impl: ReturnType<typeof streamAwaiter>;

  constructor(public options: streamAwaiterOptions) {
    this.impl = streamAwaiter<T>(options);
    this.stateTracker = this.impl.stateTracker;
    this.outgoingStream = options.outgoingStream;
    this.incomingStream = options.incomingStream;
    this.writeChannel = options.writeChannel;
    this.readChannel = options.readChannel;
  }

  dispatch(
    message: string,
    messageType: MessageType,
    messageSourceId?: string,
    shard?: string,
    outgoingStreamOverride?: string,
    opts?: DispatchOptions
  ) {
    return this.impl.dispatch(message, messageType, messageSourceId, shard, outgoingStreamOverride, opts);
  }

  readResponseStream(shard?: string): Promise<() => Promise<void>> {
    return this.impl.readResponseStream(shard);
  }
}
