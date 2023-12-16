// @ts-ignore
import queues from 'piscina';
// @ts-ignore
import path from 'path';
import {ConsumerGroupConfigurator} from "./group";
import {ConsumerGroupConfig} from "./config";
import {ConsumerGroupMember} from "./member";

const Queue = queues.Piscina;
type ConnectionSettings = ConstructorParameters<typeof ConsumerGroupMember>[0];

export type MemberParams = {
  connectionSettings?: ConnectionSettings,
  memberSettings: {
    groupId: string,
    groupMemberId: string,
    acknowledgeProcessed?: boolean
  }
};

export class ConsumerGroupCluster extends ConsumerGroupConfigurator {
  running = false;
  fileTarget: string;

  constructor(
    connectionOptions: ConnectionSettings,
    groupOptions: ConsumerGroupConfig,
    fileTarget: string
  ) {
    super(connectionOptions, connectionOptions.topic, groupOptions);
    this.fileTarget = fileTarget;
    console.log('Starting worker against ', this.fileTarget);
  }

  createMemberOptions(memberId: string): MemberParams {
    return {
      connectionSettings: this.connectionOptions,
      memberSettings: {
        groupId: this.groupOptions.name,
        groupMemberId: this.groupOptions.name + '-' + memberId,
      }
    }
  }

  async fill() {
    const queue = new Queue({
      filename: path.resolve(this.fileTarget)
    });
    await Promise.all(Array(this.groupOptions.max).fill(0).map((_, i) => {
      return queue.run(this.createMemberOptions(i.toString()));
    }));
    this.running = true;
  }
}
