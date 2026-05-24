import { MappedStreamEvent } from '@streamerson/core';
import { EventMapRecord, StreamConsumer, StreamConsumerOptions } from './base/stream-consumer';

type ConsumerOptions<E extends EventMapRecord<any, any>> = StreamConsumerOptions<E>;
type ConsumerGroupMemberSettings = {
  groupId: string,
  groupMemberId: string
}

/** Outcome of dispatching one message to its registered handler. */
type Outcome =
  | { ok: true; response: MappedStreamEvent }
  | { ok: false; reason: 'no-handler' | 'handler-threw'; error?: unknown };

const DEFAULT_BLOCK_TIMEOUT = 100;
const DEFAULT_PREFETCH = 1;

export class ConsumerGroupMember<E extends EventMapRecord<any, any>> extends StreamConsumer<E> {
  memberSettings: ConsumerGroupMemberSettings;
  consumerSettings: ConsumerOptions<E>;
  /** Messages currently being terminalized (handler + atomic terminal transition). */
  private inFlight = 0;
  /** Set by `drain()` — stops the loop pulling new work without closing connections. */
  private draining = false;

  constructor(
    public override options: ConsumerOptions<E>,
    memberOptions: ConsumerGroupMemberSettings
  ) {
    // D1: a member must read under a stable, non-empty consumer name. An empty id
    // is the old coordinator foot-gun (it read the group as consumer "" and dropped
    // a share of messages, CG-B2). Coordination now lives in ConsumerGroupCoordinator.
    if (!memberOptions.groupMemberId) {
      throw new Error('ConsumerGroupMember requires a non-empty groupMemberId');
    }
    super({
      ...options,
      consumerGroupInstanceConfig: {
        groupId: memberOptions.groupId,
        groupMemberId: memberOptions.groupMemberId
      }
    });
    this.consumerSettings = options;
    this.memberSettings = memberOptions;
    // A member replies via respondAndAck on the incoming control connection (atomic
    // {XADD response; XACK}); the base-created outgoing channel is never written to,
    // so drop it rather than carry a dead field and open a second idle connection.
    this.outgoingChannel = undefined;
    this.outgoingStream = undefined;
  }

  /**
   * Read this member's consumer-group stream and drive each message to a terminal
   * state. One message is fully terminalized before the next is read (PREFETCH=1),
   * so the group PEL holds ~one in-flight entry per member and an abandoned entry's
   * idle time tracks a single handler.
   *
   * Default contract (no retry) — every message reaches a terminal state atomically:
   *   - success       -> (bidirectional) {XADD response; XACK}; else plain XACK  => DONE;
   *   - no-handler /
   *     handler-threw  -> {XADD dead-letter; XACK}                               => FAILED.
   * An entry leaves the PEL only as part of an atomic terminal transition, so nothing is
   * silently dropped. An entry abandoned by a crashed process stays in the PEL and is
   * terminalized to the dead-letter stream by the coordinator's reaper (§6).
   */
  override async connectAndListen(): Promise<void> {
    await this.incomingChannel.connect();

    this.logger.info(
      {
        stream: this.topic.consumerKey(this.options.shard),
        ...this.memberSettings,
        blockTimeout: this.options.blockTimeout ?? DEFAULT_BLOCK_TIMEOUT,
        prefetch: this.options.prefetch ?? DEFAULT_PREFETCH
      },
      'Consumer group member listening'
    );

    // The read loop runs in the background; connectAndListen resolves once listening
    // (so callers — and the cluster worker's `ready` signal — don't block on it).
    void this.listen().catch((err) => this.logger.error(err, 'Consumer group read loop terminated'));
  }

  private get retry(): { maxAttempts: number } | undefined {
    return this.options.retry;
  }

  /**
   * Single consume loop (REQUEST_STREAM_RECEIPT.md §6.3): one serialized handler
   * pipeline fed by, in order, [self-PEL drain on (re)start] → [reclaim stale, retry
   * only, throttled to once per grace] → [XREADGROUP '>']. One message is fully
   * terminalized before the next is read (PREFETCH=1).
   */
  private async listen(): Promise<void> {
    const stream = this.topic.consumerKey(this.options.shard);
    const consumerGroupInstanceConfig = {
      groupId: this.memberSettings.groupId,
      groupMemberId: this.memberSettings.groupMemberId
    };
    const blockingTimeout = this.options.blockTimeout ?? DEFAULT_BLOCK_TIMEOUT;
    const requestedBatchSize = this.options.prefetch ?? DEFAULT_PREFETCH;
    const grace = this.options.processingTimeout ?? 0;

    // Retry (at-least-once): re-run our own previously-delivered-unacked entries
    // before taking new work, so a restarted member resumes its in-flight set.
    if (this.retry) {
      try { await this.selfDrain(stream, requestedBatchSize); }
      catch (err) { if (!this.incomingChannel.isClosing) this.logger.error(err, 'Self-drain of own PEL failed'); }
    }

    let lastReclaim = 0;
    while (!this.incomingChannel.isClosing && !this.draining) {
      // Cross-machine reclaim (retry only), throttled to once per grace: re-run
      // entries abandoned by a dead/stuck member (idle ≥ grace), capped by maxAttempts.
      if (this.retry && grace > 0 && Date.now() - lastReclaim >= grace) {
        lastReclaim = Date.now();
        try { await this.reclaimStale(stream, grace, requestedBatchSize); }
        catch (err) { if (!this.incomingChannel.isClosing) this.logger.error(err, 'Reclaim pass failed'); }
        if (this.incomingChannel.isClosing || this.draining) break;
      }

      let events: MappedStreamEvent[];
      try {
        ({ events } = (await this.incomingChannel.blockingStreamBatchMap({
          stream,
          last: '>',
          shard: this.options.shard,
          consumerGroupInstanceConfig,
          blockingTimeout,
          requestedBatchSize
        })) as { events: MappedStreamEvent[] });
      } catch (err) {
        if (this.incomingChannel.isClosing) break;
        this.logger.error(err, 'Consumer group read failed; retrying');
        continue;
      }
      for (const event of events) {
        this.inFlight++;
        try {
          await this.terminal(event, await this.dispatch(event));
        } catch (err) {
          // A terminal-transition failure (e.g. response write) leaves the entry
          // unacked → pending → recoverable. Never let it kill the loop.
          this.logger.error({ messageId: event.messageId, err }, 'Terminal transition failed; entry left pending');
        } finally {
          this.inFlight--;
        }
        if (this.incomingChannel.isClosing || this.draining) break;
      }
    }
  }

  /**
   * Graceful drain (CG-I3): stop pulling new work, let the in-flight message finish
   * terminalizing (so its response + ack flush on the still-open connection — bounded
   * by `idleTimeoutMs`), then disconnect. An abrupt {@link disconnect} instead leaves
   * any in-flight entry pending in the PEL for the reaper/retry to recover (no loss),
   * so drain is an optimization over that safety net, not a correctness requirement.
   */
  async drain(idleTimeoutMs: number): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + Math.max(0, idleTimeoutMs);
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await this.disconnect();
  }

  /**
   * Re-run this consumer's own pending entries (read at id '0') until the PEL drains.
   * Termination is guaranteed: each '0' re-read bumps an entry's delivery count, so a
   * still-failing entry eventually exceeds `maxAttempts` and is dead-lettered.
   */
  private async selfDrain(stream: string, count: number): Promise<void> {
    const { groupId, groupMemberId } = this.memberSettings;
    while (!this.incomingChannel.isClosing) {
      const events = await this.incomingChannel.readGroupEntries(stream, groupId, groupMemberId, '0', 0, count);
      if (!events.length) break;
      const counts = await this.deliveryCounts(stream, groupMemberId);
      for (const event of events) {
        if (this.incomingChannel.isClosing) return;
        await this.attempt(event, counts.get(event.streamMessageId!) ?? 1);
      }
    }
  }

  /** Reclaim stale entries (idle ≥ grace) into this member and re-run them; poison → DLQ. */
  private async reclaimStale(stream: string, grace: number, count: number): Promise<void> {
    const { groupId, groupMemberId } = this.memberSettings;
    let cursor = '0-0';
    do {
      const { cursor: next, entries } = await this.incomingChannel.claimStale(stream, groupId, groupMemberId, grace, cursor, count);
      if (entries.length) {
        const counts = await this.deliveryCounts(stream, groupMemberId);
        for (const event of entries) {
          if (this.incomingChannel.isClosing) return;
          await this.attempt(event, counts.get(event.streamMessageId!) ?? 1);
        }
      }
      cursor = next;
    } while (cursor !== '0-0' && !this.incomingChannel.isClosing);
  }

  /** A retry attempt: a poison entry (delivery count past the cap) is dead-lettered; otherwise re-run. */
  private async attempt(event: MappedStreamEvent, deliveryCount: number): Promise<void> {
    this.inFlight++;
    try {
      if (deliveryCount > this.retry!.maxAttempts) {
        await this.deadLetter(event, 'handler-threw', String(deliveryCount));
        this.logger.warn({ messageId: event.messageId, deliveryCount }, 'Retry exhausted; dead-lettered poison message');
        return;
      }
      await this.terminal(event, await this.dispatch(event));
    } finally {
      this.inFlight--;
    }
  }

  /** Map of this consumer's pending entries → current delivery count. */
  private async deliveryCounts(stream: string, consumer: string): Promise<Map<string, number>> {
    const details = await this.incomingChannel.pendingDetails(stream, this.memberSettings.groupId, 1000, consumer);
    return new Map(details.map((d) => [d.id, d.deliveryCount]));
  }

  /** Run the registered handler for a message, classifying the result. */
  private async dispatch(event: MappedStreamEvent): Promise<Outcome> {
    if (!this.streamEvents[event.messageType]) {
      return { ok: false, reason: 'no-handler' };
    }
    try {
      return { ok: true, response: await this._handle_message(event) };
    } catch (error) {
      return { ok: false, reason: 'handler-threw', error };
    }
  }

  /**
   * Apply the terminal transition for a dispatched message — atomically, via Lua,
   * so the record (response or dead-letter) is durable iff the request leaves the
   * PEL (CG-I6). Default contract (no retry): every message reaches DONE or
   * FAILED, never silently dropped.
   */
  private async terminal(event: MappedStreamEvent, outcome: Outcome): Promise<void> {
    const consumerStream = this.topic.consumerKey(this.options.shard);
    if (outcome.ok) {
      if (this.bidirectional) {
        // DONE (bidirectional): {XADD response; XACK} as one Lua call.
        await this.incomingChannel.respondAndAck({
          producerStream: this.topic.producerKey(this.options.shard),
          consumerStream,
          groupId: this.memberSettings.groupId,
          streamMessageId: event.streamMessageId!,
          messageId: event.messageId,
          messageType: String(outcome.response.messageType ?? 'resp'),
          messageSourceId: event.messageSourceId ?? '',
          payload: JSON.stringify(outcome.response.payload),
        });
      } else {
        // DONE (one-way): a plain XACK; no response to make atomic.
        await this.incomingChannel.markProcessedByGroup(
          this.topic, this.memberSettings.groupId, event.streamMessageId!, this.options.shard,
        );
      }
      return;
    }
    // Retry on + handler threw: leave the entry pending (unacked) so a later self-drain
    // or reclaim re-runs it, up to `maxAttempts` (then poison → DLQ via `attempt`). A
    // no-handler is a config error retry can't fix, so it is dead-lettered regardless.
    if (this.retry && outcome.reason === 'handler-threw') {
      this.logger.warn({ messageId: event.messageId, messageType: event.messageType }, 'Handler threw; left pending for retry');
      return;
    }
    // FAILED (no retry, or no-handler): record the cause and XACK as one atomic Lua call.
    await this.deadLetter(event, outcome.reason, '1');
    this.logger.warn(
      { messageId: event.messageId, messageType: event.messageType, reason: outcome.reason },
      'Handler did not succeed; dead-lettered',
    );
  }

  /** Atomically record a dead-letter entry (cause + provenance) and XACK the request. */
  private async deadLetter(event: MappedStreamEvent, reason: 'no-handler' | 'handler-threw', deliveryCount: string): Promise<void> {
    await this.incomingChannel.deadLetterAndAck({
      deadLetterStream: this.topic.deadLetterKey(this.options.shard),
      consumerStream: this.topic.consumerKey(this.options.shard),
      groupId: this.memberSettings.groupId,
      streamMessageId: event.streamMessageId!,
      messageId: event.messageId,
      reason,
      consumer: this.memberSettings.groupMemberId,
      deliveryCount,
      payload: JSON.stringify(event.payload ?? null),
      failedAt: String(Date.now()),
    });
  }

  clone(options?: Partial<ConsumerGroupMemberSettings>) {
    return new ConsumerGroupMember(this.consumerSettings, {
      ...this.memberSettings,
      ...options
    });
  }
}
