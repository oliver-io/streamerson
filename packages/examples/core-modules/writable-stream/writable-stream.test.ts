import { test } from 'bun:test';

// The writable-stream example connects to Redis and runs as a long-running
// top-level script, so it can't be imported-and-stopped here.
// The example is instead verified to compile via `bun run verify-examples`.
test.skip('the writable-stream example connects and writes', () => {});
