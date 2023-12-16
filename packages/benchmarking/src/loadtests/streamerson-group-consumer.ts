import {ConsumerGroupMember, MemberParams} from '@streamerson/consumer';

// This function gets picked up by Piscina:
export default async function run(params: MemberParams) {
  console.log('Starting stream cluster member....');
  const groupMember = new ConsumerGroupMember(params.connectionSettings, params.memberSettings);
  groupMember.registerStreamEvent('test', async () => {
    console.log('TEST EVENT');
    return {
      ok: "wat"
    }
  })
  await groupMember.connectAndListen();
}
