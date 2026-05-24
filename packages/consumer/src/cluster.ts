/// <reference types="bun" />
import path from 'path';
import { pathToFileURL } from 'url';
import { Topic } from '@streamerson/core';
import { ConsumerGroupCoordinator } from './group';
import { ConsumerGroupConfig, ConsumerGroupOptions, createConsumerGroupConfig } from './config';
import { EventMapRecord, StreamConsumerOptions } from './base/stream-consumer';
import { ClusterCommand, ClusterConnectionSettings, MemberParams, MemberSignal } from './cluster-protocol';

/**
 * Connection options for a cluster. A clone-safe subset of the consumer options:
 * `eventMap`/`logger` are excluded because handlers and loggers cannot cross the
 * worker boundary — they are built worker-side (see `runClusterMember`).
 */
export type ClusterConnectionOptions = Omit<StreamConsumerOptions<EventMapRecord<any, any>>, 'eventMap' | 'logger'>;

const RESTART_BASE_DELAY_MS = 100;
const RESTART_MAX_DELAY_MS = 5_000;
const MAX_RESTARTS = 10;
const DRAIN_TERMINATE_SLACK_MS = 250;

type ManagedWorker = {
  worker: Worker;
  groupMemberId: string;
  /** Set when the coordinator is intentionally tearing this member down — suppresses restart. */
  draining: boolean;
  /** True once the member has signalled `ready` at least once. */
  everReady: boolean;
};

/**
 * Supervises a pool of long-lived consumer-group members, one per Bun `Worker`
 * thread (block-for-life). The coordinator itself never reads the stream: it
 * owns an admin connection (`ConsumerGroupConfigurator`) to create the group,
 * spawns/drains member workers, and keeps the desired member count alive across
 * crashes. The member count is set at construction (`count`) and is mutable at
 * runtime via `scale()`, so an external control plane can drive cluster size.
 */
export class ConsumerGroupCluster {
  /** Admin-only group coordinator; creates the consumer group, never consumes. */
  readonly coordinator: ConsumerGroupCoordinator;
  readonly groupConfig: ConsumerGroupConfig;

  private readonly connectionOptions: ClusterConnectionOptions;
  private readonly workerUrl: string;
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly restartCounts = new Map<string, number>();
  private desiredCount = 0;
  private memberSeq = 0;
  private running = false;

  constructor(
    connectionOptions: ClusterConnectionOptions,
    groupOptions: ConsumerGroupOptions,
    fileTarget: string,
  ) {
    this.connectionOptions = connectionOptions;
    this.groupConfig = createConsumerGroupConfig(groupOptions);
    this.coordinator = new ConsumerGroupCoordinator(connectionOptions, groupOptions);
    // Bun resolves a worker specifier against the project root; pin it to an
    // absolute file URL so the target is unambiguous regardless of cwd.
    this.workerUrl = pathToFileURL(path.resolve(fileTarget)).href;
  }

  /** Desired live-member count (the target `scale()`/restart reconcile toward). */
  get count(): number {
    return this.desiredCount;
  }

  /** Currently live member workers, including those still connecting. */
  get members(): number {
    return this.workers.size;
  }

  /** Member workers that have connected and signalled `ready` (fully operational). */
  get readyMembers(): number {
    let ready = 0;
    for (const managed of this.workers.values()) {
      if (managed.everReady) ready++;
    }
    return ready;
  }

  get topic(): Topic {
    return this.coordinator.topic;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Connect the coordinator, create the consumer group, start the reaper, and spawn `count` members. */
  async start(): Promise<void> {
    await this.coordinator.connect();
    await this.coordinator.create();
    this.coordinator.startReaper();
    this.running = true;
    await this.scale(this.groupConfig.count);
  }

  /** @deprecated Use {@link start}. Retained for back-compat with the prior Piscina API. */
  async fill(): Promise<void> {
    return this.start();
  }

  /**
   * Set the desired live-member count and reconcile: spawn new members or
   * gracefully drain excess ones. Awaits new members reaching `ready` and
   * drained members exiting. Safe to call repeatedly at runtime.
   */
  async scale(target: number): Promise<void> {
    if (!Number.isInteger(target) || target < 0) {
      throw new Error('scale target must be a non-negative integer');
    }
    this.desiredCount = target;
    const delta = target - this.workers.size;
    if (delta > 0) {
      await Promise.all(Array.from({ length: delta }, () => this.spawnMember()));
    } else if (delta < 0) {
      const victims = Array.from(this.workers.values()).slice(0, -delta);
      await Promise.all(victims.map((managed) => this.drainMember(managed)));
    }
  }

  /** Gracefully drain every member and tear down the coordinator connection. */
  async stop(): Promise<void> {
    this.running = false;
    this.desiredCount = 0;
    await Promise.all(Array.from(this.workers.values()).map((managed) => this.drainMember(managed)));
    await this.coordinator.disconnect();
  }

  /** The clone-safe payload sent to a member worker to start it. */
  createMemberOptions(groupMemberId: string): MemberParams {
    const topic = this.coordinator.topic;
    const connectionSettings: ClusterConnectionSettings = {
      topic: { namespace: topic.namespace, topic: topic.topic, mode: topic.mode },
      redisConfiguration: this.connectionOptions.redisConfiguration,
      bidirectional: this.connectionOptions.bidirectional ?? true,
      blockTimeout: this.groupConfig.blockTimeout,
      prefetch: this.groupConfig.prefetch,
      processingTimeout: this.groupConfig.processingTimeout,
      retry: this.groupConfig.retry,
    };
    return {
      connectionSettings,
      memberSettings: {
        groupId: this.groupConfig.name,
        groupMemberId,
      },
      processingTimeout: this.groupConfig.processingTimeout,
      idleTimeout: this.groupConfig.idleTimeout,
    };
  }

  private spawnMember(reuseId?: string): Promise<void> {
    const groupMemberId = reuseId ?? `${this.groupConfig.name}-${this.memberSeq++}`;
    const worker = new Worker(this.workerUrl, { ref: true });
    const managed: ManagedWorker = { worker, groupMemberId, draining: false, everReady: false };
    this.workers.set(groupMemberId, managed);

    return new Promise<void>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent) => {
        const signal = event.data as MemberSignal;
        if (signal?.type === 'ready') {
          managed.everReady = true;
          this.restartCounts.set(groupMemberId, 0);
          this.coordinator.logger.info({ groupMemberId }, 'Cluster member ready');
          resolve();
        } else if (signal?.type === 'error') {
          this.coordinator.logger.error({ groupMemberId, message: signal.message }, 'Cluster member reported error');
        }
      });

      worker.addEventListener('error', (event) => {
        this.coordinator.logger.error(
          { groupMemberId, message: (event as ErrorEvent)?.message },
          'Cluster member worker error',
        );
      });

      worker.addEventListener('close', () => {
        this.workers.delete(groupMemberId);
        if (!managed.everReady) {
          reject(new Error(`Cluster member ${groupMemberId} exited before becoming ready`));
          return;
        }
        this.scheduleRestart(managed);
      });

      worker.postMessage({ type: 'start', params: this.createMemberOptions(groupMemberId) } satisfies ClusterCommand);
    });
  }

  /** Refill a crashed member toward the desired count with bounded exponential backoff. */
  private scheduleRestart(managed: ManagedWorker): void {
    if (!this.running || managed.draining || this.workers.size >= this.desiredCount) {
      return;
    }
    const attempts = this.restartCounts.get(managed.groupMemberId) ?? 0;
    if (attempts >= MAX_RESTARTS) {
      this.coordinator.logger.error(
        { groupMemberId: managed.groupMemberId, attempts },
        'Cluster member exceeded restart limit; giving up',
      );
      return;
    }
    this.restartCounts.set(managed.groupMemberId, attempts + 1);
    const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** attempts);
    this.coordinator.logger.warn(
      { groupMemberId: managed.groupMemberId, attempt: attempts + 1, delay },
      'Restarting crashed cluster member',
    );
    setTimeout(() => {
      if (this.running && !this.workers.has(managed.groupMemberId) && this.workers.size < this.desiredCount) {
        this.spawnMember(managed.groupMemberId).catch((err) => {
          this.coordinator.logger.error({ groupMemberId: managed.groupMemberId, err }, 'Cluster member restart failed');
        });
      }
    }, delay);
  }

  /** Signal a member to drain; force-terminate if it overruns its drain budget. */
  private drainMember(managed: ManagedWorker): Promise<void> {
    managed.draining = true;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(managed.groupMemberId);
        resolve();
      };
      managed.worker.addEventListener('close', finish);
      const timer = setTimeout(() => {
        try {
          managed.worker.terminate();
        } catch {
          // worker may already be gone
        }
        finish();
      }, this.groupConfig.idleTimeout + DRAIN_TERMINATE_SLACK_MS);
      managed.worker.postMessage({ type: 'drain' } satisfies ClusterCommand);
    });
  }
}
