// Bun Worker entry for the processingTimeout-budget test: 'hang' never settles
// (the wrapHandlers budget in runClusterMember must reject it), 'echo' round-trips.
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        hang: (() => new Promise(() => { /* never settles */ })) as any,
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
      },
    },
    params.memberSettings,
  );
});
