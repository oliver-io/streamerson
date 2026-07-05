/// <reference types="bun" />
import type { ConsumerGroupMember } from './member';
import type { EventMapRecord } from './base/stream-consumer';
import type { ClusterCommand, MemberParams, MemberSignal } from './cluster-protocol';

/**
 * Build a configured-but-not-yet-listening member from the coordinator's params.
 * The helper owns the lifecycle (handler-budget wrapping, `connectAndListen`,
 * drain), so the factory must NOT call `connectAndListen` itself — just
 * construct the member and register its handlers (via `eventMap` or
 * `registerStreamEvent`) and return it.
 */
export type MemberFactory = (
  params: MemberParams,
) => ConsumerGroupMember<EventMapRecord<any, any>> | Promise<ConsumerGroupMember<EventMapRecord<any, any>>>;

// Variadic on purpose (D-2.13): a base consumer dispatches `(event)`, but a state
// machine dispatches its canonical `(stateTransformers, payload, meta)` — the wrapper
// below must be signature-preserving for both.
type Handler = (...args: unknown[]) => Promise<unknown>;

/**
 * Worker entry point for a `ConsumerGroupCluster` member. Call once at module
 * top level in a worker file; the coordinator drives it over `postMessage`:
 *
 *   import { runClusterMember, ConsumerGroupMember } from '@streamerson/consumer';
 *   runClusterMember((params) => new ConsumerGroupMember(
 *     { ...params.connectionSettings, eventMap: { ... } }, params.memberSettings));
 *
 * Lifecycle: on `start` it builds the member, wraps each handler with the
 * `processingTimeout` budget + in-flight accounting, connects, and signals
 * `ready`. On `drain` it stops reading, lets in-flight handlers finish (bounded
 * by `idleTimeout`), disconnects, and exits 0. A build/connect failure signals
 * `error` and exits 1 so the coordinator can restart the member.
 */
export function runClusterMember(build: MemberFactory): void {
  let member: ConsumerGroupMember<EventMapRecord<any, any>> | undefined;
  let idleTimeout = 0;
  let draining = false;

  const post = (signal: MemberSignal) => self.postMessage(signal);

  // Wrap each handler with the per-message time budget. In-flight accounting and the
  // drain wait live in the member (it owns the full handler + terminal lifecycle), so
  // this only enforces `processingTimeout`.
  const wrapHandlers = (target: ConsumerGroupMember<EventMapRecord<any, any>>, processingTimeout: number) => {
    if (processingTimeout <= 0) return;
    const handlers = target.streamEvents as Record<string, Handler | undefined>;
    for (const key of Object.keys(handlers)) {
      const original = handlers[key];
      if (!original) continue;
      // Signature-preserving pass-through (D-2.13): forward ALL arguments so a state
      // machine's canonical (stateTransformers, payload, meta) survives the wrap.
      handlers[key] = async (...args: unknown[]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            original(...args),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`handler '${key}' exceeded processingTimeout ${processingTimeout}ms`)),
                processingTimeout,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
    }
  };

  const drain = async () => {
    draining = true;
    // The member stops reading, lets the in-flight message finish terminalizing (so
    // its response + ack flush before the connection closes, bounded by idleTimeout),
    // then disconnects.
    if (member) await member.drain(idleTimeout);
    process.exit(0);
  };

  self.onmessage = async (event: MessageEvent) => {
    const command = event.data as ClusterCommand;
    if (!command) return;
    if (command.type === 'start') {
      const { groupMemberId } = command.params.memberSettings;
      try {
        idleTimeout = command.params.idleTimeout;
        member = await build(command.params);
        wrapHandlers(member, command.params.processingTimeout);
        await member.connectAndListen();
        post({ type: 'ready', groupMemberId });
      } catch (err) {
        post({ type: 'error', groupMemberId, message: (err as Error)?.message ?? String(err) });
        process.exit(1);
      }
    } else if (command.type === 'drain' && !draining) {
      await drain();
    }
  };
}
