// Bun Worker entry that becomes ready and then crashes shortly after — a "flapping"
// member. Used by restart.test.ts to exercise the coordinator's restart/backoff loop
// across many crash cycles. The self-crash is scheduled in the factory (before connect),
// so `ready` is reliably signalled first, then the worker exits ~100ms later.
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  setTimeout(() => process.exit(1), 150);
  return new ConsumerGroupMember(
    { ...params.connectionSettings, eventMap: { echo: async () => ({ ok: true }) } },
    params.memberSettings,
  );
});
