import {ConsumerGroupMember, MemberParams} from '@streamerson/consumer';
import pino from 'pino';

// This function gets picked up by Piscina:
export default async function run(params: MemberParams) {
  console.log('Starting stream cluster member !!!! ...');
  console.log('Cluster details: ', {
    conn: params.connectionSettings,
    memb: params.memberSettings
  })
  const groupMember = new ConsumerGroupMember({
    ...params.connectionSettings,
    eventMap: {
      resp: async ()=>{
        console.log('What the FUCK wat wat wat');
        return { ok: true }
      }
    },
    consumerGroupInstanceConfig: {
      groupId: 'wat',
      groupMemberId: params.memberSettings.groupMemberId,
    },
    logger: pino({
      level: 'debug'
    }) as any,
  }, params.memberSettings);
  groupMember.registerStreamEvent('resp', async () => {
    console.log('TEST EVENT');
    return {
      ok: "wat"
    }
  });
  await groupMember.connectAndListen();
  console.log('WAT WAT WAT WAT \r\n')
}
