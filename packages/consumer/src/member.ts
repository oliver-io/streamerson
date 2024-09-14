import { MappedStreamEvent, TopicOptions } from '@streamerson/core';
import { EventMapRecord, StreamConsumer, StreamConsumerOptions } from '@streamerson/consumer';

type ConsumerOptions<E extends EventMapRecord<any, any>> = StreamConsumerOptions<E>;
type ConsumerGroupMemberSettings = {
  groupId: string,
  groupMemberId: string,
  acknowledgeProcessed?: boolean
}

export class ConsumerGroupMember<E extends EventMapRecord<any, any>> extends StreamConsumer<E> {
  memberSettings: ConsumerGroupMemberSettings;
  consumerSettings: ConsumerOptions<E>;

  constructor(
    public override options: ConsumerOptions<E>,
    memberOptions: ConsumerGroupMemberSettings
  ) {
    super({
      ...options,
      consumerGroupInstanceConfig: {
        groupId: memberOptions.groupId,
        groupMemberId: memberOptions.groupMemberId
      }
    });
    this.consumerSettings = options;
    this.memberSettings = memberOptions;
  }

  override async process(streamMessage: MappedStreamEvent): Promise<MappedStreamEvent | Error> {
    if (!this.memberSettings.groupId) {
      throw new Error('Cannot process consumer group message without group ID');
    }
    const result = await super.process(streamMessage);
    if (result && this.memberSettings.acknowledgeProcessed) {
      await this.incomingChannel.markProcessedByGroup(
        this.topic,
        this.memberSettings.groupId,
        streamMessage.streamMessageId!,
        this.options.shard
      );
    }
    return result;
  }

  override async connectAndListen(): Promise<void> {
    return await super.connectAndListen({ consumerGroupInstanceConfig: this.memberSettings });
  }

  clone(options?: Partial<ConsumerGroupMemberSettings>) {
    return new ConsumerGroupMember(this.consumerSettings, {
      ...this.memberSettings,
      ...options
    });
  }
}
