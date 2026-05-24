// Bun Worker entry whose factory throws during build — used by cluster-misc.test.ts to
// exercise runClusterMember's failure path: on a build error it must signal `error` and
// exit non-zero so the coordinator sees the member never became ready.
import { runClusterMember } from '../../src/index';

runClusterMember(() => {
  throw new Error('intentional build failure');
});
