import type { TopicOptions } from '@streamerson/core';

/**
 * The contract for everything that crosses the coordinator↔worker boundary.
 *
 * Bun `Worker.postMessage` uses structured clone, so only plain data may cross:
 * no functions (handlers/`eventMap`), no class instances (`Topic`, a Redis
 * client, a pino logger). Those are reconstructed worker-side from this plain
 * payload — see `runClusterMember`. Keep this module type-only and dependency-free
 * so it can be imported from both the coordinator and the worker entry.
 */

/** Clone-safe connection settings the coordinator hands to each member. */
export type ClusterConnectionSettings = {
  /** Plain topic options; the worker rebuilds a `Topic` from these. */
  topic: TopicOptions;
  redisConfiguration?: { host?: string; port?: number };
  bidirectional?: boolean;
  /** XREADGROUP BLOCK cadence, ms, for the member read loop. Default 100. */
  blockTimeout?: number;
  /** Messages pulled per read; default 1 (one in-flight at a time). */
  prefetch?: number;
  /** Abandonment grace / reclaim idle threshold, ms (mirrors `processingTimeout`). */
  processingTimeout?: number;
  /** Opt-in retry: at-least-once, idempotent handlers required. */
  retry?: { maxAttempts: number };
};

export type MemberSettings = {
  groupId: string;
  groupMemberId: string;
};

/** The full start payload posted to a worker to bring up one group member. */
export type MemberParams = {
  connectionSettings: ClusterConnectionSettings;
  memberSettings: MemberSettings;
  /** Per-message handler budget, ms; `0` disables. Enforced worker-side. */
  processingTimeout: number;
  /** Drain budget, ms, for in-flight handlers when the coordinator drains this member. */
  idleTimeout: number;
};

/** coordinator → worker */
export type ClusterCommand =
  | { type: 'start'; params: MemberParams }
  | { type: 'drain' };

/** worker → coordinator */
export type MemberSignal =
  | { type: 'ready'; groupMemberId: string }
  | { type: 'error'; groupMemberId: string; message: string };
