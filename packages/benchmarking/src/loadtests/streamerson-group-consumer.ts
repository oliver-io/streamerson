import { ConsumerGroupMember, runClusterMember } from '@streamerson/consumer';
import pino from 'pino';

// Bun Worker entry for a cluster member. The cluster coordinator spawns this
// file as a worker and drives its lifecycle; `runClusterMember` owns connect/
// drain, so the factory only constructs the member and registers handlers.
runClusterMember((params) => {
  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        resp: async () => ({ ok: true }),
      },
      logger: pino({ level: 'debug' }) as any,
    },
    params.memberSettings,
  );
});
