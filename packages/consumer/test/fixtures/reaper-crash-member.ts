// Bun Worker entry used by reaper-real-crash.test.ts. Default-mode member (no
// retry): a `boom` message hard-kills the worker thread AFTER delivery into its
// PEL and before any ack, leaving a genuinely abandoned pending entry for the
// coordinator's reaper to terminalize.
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        // Healthy round-trip handler, for the conservation half of the invariant.
        echo: async (e: any) => ({ ok: true, echoed: e.payload?.hi }),
        // Real crash: the entry is in this consumer's PEL (XREADGROUP happened);
        // exiting here means no handler result, no XACK, no dead-letter — thread death.
        boom: async () => {
          process.exit(1);
        },
      },
    },
    params.memberSettings,
  );
});
