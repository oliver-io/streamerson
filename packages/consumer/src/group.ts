import {
  createStreamersonLogger,
  StreamersonLogger,
  StreamingDataSource,
  Topic,
  TopicOptions,
} from '@streamerson/core';
import { ConsumerGroupConfig, ConsumerGroupOptions, createConsumerGroupConfig } from './config';

export type CoordinatorConnectionOptions = {
  topic: Topic | TopicOptions;
  redisConfiguration?: { host?: string; port?: number };
  logger?: StreamersonLogger;
  shard?: string;
};

/** Result of an idempotent group create: `created` is false when the group already existed. */
export type GroupCreateResult = { created: boolean };

/**
 * Admin-side group coordinator. Creates the consumer group and (Phase 3) hosts the
 * reaper — it **never consumes messages** (no handler, no `XREADGROUP`). This is the
 * structural coordinator/member split (CONSUMER_GROUP.md D3, REQUEST_STREAM_RECEIPT.md §3.1):
 * a pure creator can no longer steal a share of messages as a phantom `''` consumer (CG-B2).
 *
 * It owns a single control-capable `StreamingDataSource` (not a `StreamConsumer`), so there is
 * no inherited read path to misfire.
 */
export class ConsumerGroupCoordinator {
  readonly topic: Topic;
  readonly groupConfig: ConsumerGroupConfig;
  readonly dataSource: StreamingDataSource;
  readonly logger: StreamersonLogger;

  /** Reserved consumer name the reaper claims abandoned entries into. */
  private static readonly REAPER_CONSUMER = '__reaper';
  private reaperTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    public connectionOptions: CoordinatorConnectionOptions,
    groupOptions: ConsumerGroupOptions,
  ) {
    this.topic = connectionOptions.topic instanceof Topic ? connectionOptions.topic : new Topic(connectionOptions.topic);
    this.groupConfig = createConsumerGroupConfig(groupOptions);
    this.logger = createStreamersonLogger(
      { ...this.topic.meta(), module: 'streamerson_consumer_coordinator', group: this.groupConfig.name },
      connectionOptions.logger,
    );
    this.dataSource = new StreamingDataSource({
      host: connectionOptions.redisConfiguration?.host,
      port: connectionOptions.redisConfiguration?.port,
      logger: this.logger as any,
      controllable: true,
    });
  }

  async connect(): Promise<void> {
    await this.dataSource.connect();
  }

  /**
   * Create the consumer group (idempotent). Surfaces real failures (CG-A5): a non-`BUSYGROUP`
   * error from `XGROUP CREATE` propagates to the caller instead of being logged and swallowed,
   * so a misconfigured stream/group can no longer masquerade as success.
   */
  async create(cursor?: string, shard?: string): Promise<GroupCreateResult> {
    const stream = this.topic.consumerKey(shard ?? this.connectionOptions.shard);
    const result = await this.dataSource.createConsumerGroup({ stream, groupId: this.groupConfig.name, cursor });
    const created = result !== 'BUSYGROUP';
    this.logger.info({ stream, group: this.groupConfig.name, created }, 'Consumer group ensured');
    return { created };
  }

  /** Connect and begin coordinating: start the reaper (if a grace is configured). */
  async connectAndListen(): Promise<void> {
    await this.connect();
    this.startReaper();
  }

  async disconnect(): Promise<void> {
    this.stopReaper();
    await this.dataSource.disconnect();
  }

  /**
   * Start the reaper: every `processingTimeout` ms, sweep the group's PEL for
   * entries idle ≥ `processingTimeout` (abandoned by a crashed/stuck member) and
   * terminalize them to the dead-letter stream (§6). Disabled when
   * `processingTimeout` is 0 — without an abandonment grace there is no safe idle
   * threshold (a smaller grace than the worst-case handler time would steal
   * in-flight work, CG-I7). Idempotent.
   */
  startReaper(shard?: string): void {
    const grace = this.groupConfig.processingTimeout;
    // In retry mode, members reclaim-and-re-run abandoned entries themselves; the
    // coordinator must NOT also DLQ them, so its reaper stays off.
    if (grace <= 0 || this.reaperTimer || this.groupConfig.retry) return;
    const consumerStream = this.topic.consumerKey(shard ?? this.connectionOptions.shard);
    const deadLetterStream = this.topic.deadLetterKey(shard ?? this.connectionOptions.shard);
    this.reaperTimer = setInterval(() => {
      void this.sweep(consumerStream, deadLetterStream, grace);
    }, grace);
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
  }

  /** One reaper pass: XAUTOCLAIM stale entries and dead-letter each, atomically. */
  private async sweep(consumerStream: string, deadLetterStream: string, grace: number): Promise<void> {
    if (this.sweeping || this.dataSource.isClosing) return;
    this.sweeping = true;
    try {
      let cursor = '0-0';
      do {
        const { cursor: next, entries } = await this.dataSource.claimStale(
          consumerStream, this.groupConfig.name, ConsumerGroupCoordinator.REAPER_CONSUMER, grace, cursor,
        );
        for (const entry of entries) {
          await this.dataSource.deadLetterAndAck({
            deadLetterStream,
            consumerStream,
            groupId: this.groupConfig.name,
            streamMessageId: entry.streamMessageId!,
            messageId: entry.messageId,
            reason: 'abandoned',
            consumer: ConsumerGroupCoordinator.REAPER_CONSUMER,
            deliveryCount: '',
            payload: JSON.stringify(entry.payload ?? null),
            failedAt: String(Date.now()),
          });
          this.logger.warn(
            { messageId: entry.messageId, streamMessageId: entry.streamMessageId },
            'Reaper dead-lettered abandoned entry',
          );
        }
        cursor = next;
      } while (cursor !== '0-0');
    } catch (err) {
      // NOGROUP (group not created yet) is benign — the next sweep retries.
      if (!String((err as Error).message).includes('NOGROUP')) {
        this.logger.error(err, 'Reaper sweep failed');
      }
    } finally {
      this.sweeping = false;
    }
  }
}
