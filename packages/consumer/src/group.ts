import {ConsumerGroupConfig, ConsumerGroupOptions, createConsumerGroupConfig} from "./config";
import {StreamingDataSource, Topic, TopicOptions} from "@streamerson/core";
import {ConsumerGroupMember} from "./member";

type ConnectionSettings = ConstructorParameters<typeof ConsumerGroupMember>[0];
export class ConsumerGroupConfigurator extends ConsumerGroupMember<any> {
  connectionOptions: ConnectionSettings;
  topicOptions: TopicOptions;
  groupOptions: ConsumerGroupConfig;

  constructor(
    connectionOptions: ConnectionSettings,
    topicOptions: TopicOptions,
    groupOptions: ConsumerGroupOptions,
  ) {
    super(connectionOptions, {
      groupId: groupOptions.name,
      groupMemberId: ''
    });
    this.connectionOptions = connectionOptions;
    this.topicOptions = topicOptions;
    this.groupOptions = createConsumerGroupConfig(groupOptions);
    this.topic = new Topic(topicOptions);
  }

  async create(cursor?: string, shard?: string) {
    // TODO: add a parameter to the public options of this class that dictates
    // if we want to check for the existence of a group before we try to create it;
    // in long-running applications, this would only technically really need done once,
    // but it make stable to do it every time with an optimized check quick for exist
    console.log('Creating GROUP stream configuration in Redis');
    const consumerGroupResponse = await this.incomingChannel.createConsumerGroup({
      stream: this.topic.consumerKey(shard),
      groupId: this.groupOptions.name,
      cursor
    });

    console.log('Consumer GROUP stream configuration creation response: ', consumerGroupResponse);
  }

  instanceConfig(groupMemberId: string) {
    return {
      groupId: this.groupOptions.name,
      groupMemberId
    }
  }
}
