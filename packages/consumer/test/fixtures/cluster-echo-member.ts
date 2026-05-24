// Bun Worker entry used by cluster.test.ts. The cluster coordinator spawns this
// file as a worker thread; `runClusterMember` owns connect/drain, so the factory
// only constructs the member and registers handlers.
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        // Round-trip handler: echoes a field back so the test can assert a real
        // request -> handler -> response path through the worker thread.
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
        // Crash this worker thread to exercise the coordinator's restart-on-crash.
        boom: async () => {
          process.exit(1);
        },
        // Deliberately slow handler to exercise graceful drain: a member draining
        // mid-handler must let this finish (and flush its response) within idleTimeout.
        slow: async (e: any) => {
          await new Promise((r) => setTimeout(r, e.payload?.ms ?? 400));
          return { ok: true, slept: e.payload?.ms ?? 400 };
        },
      },
    },
    params.memberSettings,
  );
});
