import {StreamingDataSource, Topic, TopicOptions} from "..";

export class ConnectedTopic extends Topic {
  _channel: StreamingDataSource;
  connected: boolean;
  private readonly _$connected?: Promise<void>;
  constructor(
    public override options: TopicOptions,
    private channelOption?: StreamingDataSource | ConstructorParameters<typeof StreamingDataSource>[0]
  ) {
    super(options);
    this._channel = channelOption instanceof StreamingDataSource ?
      channelOption :
      new StreamingDataSource(channelOption);

    this.connected = false;
    this._$connected = this._channel.connect().then();
  }

  async connect() {
    // TODO: handle some kind of disconnection subscription here:
    await this._$connected;
    this.connected = true;
  }

  async disconnect() {
    await this._channel.disconnect();
  }

  get channel() {
    if (!this.connected) {
      throw new Error("Channel not connected; call ConnectableTopic.connect() first");
    }

    return this._channel;
  }

  async clone() {
    const topic = new ConnectedTopic(this.options, this.channelOption);
    await topic.connect();
    return topic;
  }
}
