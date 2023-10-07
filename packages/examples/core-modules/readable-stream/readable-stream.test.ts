import { test } from 'node:test';

await test('the example works for a simple readable stream', async t => {
    const { readChannel } = await import("./readable-stream.example");
    await readChannel.disconnect();
});