// Bun Worker entry used by wedged-worker-terminate.test.ts. The `wedge` handler
// is a synchronous busy-loop: the worker thread never yields to its event loop
// again, so the coordinator's `drain` postMessage is never processed and only the
// main-thread force-terminate safety net (drainMember's timer) can reclaim it.
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        wedge: async () => {
          // Synchronous CPU wedge — never resolves, never yields.
          // eslint-disable-next-line no-constant-condition
          while (true) { /* wedged */ }
        },
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
      },
    },
    params.memberSettings,
  );
});
