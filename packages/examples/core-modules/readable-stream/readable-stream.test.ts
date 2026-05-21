import { test } from 'bun:test';

// The readable-stream example connects to Redis and consumes a stream in a
// long-running top-level loop, so it can't be imported-and-stopped here.
// The example is instead verified to compile via `bun run verify-examples`.
test.skip('the readable-stream example connects and reads', () => {});
