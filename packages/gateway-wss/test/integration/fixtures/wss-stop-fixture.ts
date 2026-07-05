/**
 * Subprocess fixture for the wss shutdown test: a real gateway on
 * WSS_FIXTURE_PORT / WSS_FIXTURE_TOPIC. Prints READY when listening; when a
 * line containing "stop" arrives on stdin it calls `wss.stop()` and prints
 * STOPPED. If teardown is complete (sockets closed, read loop ended, datasource
 * disconnected) the event loop drains and the process exits 0 on its own.
 */
import { Topic } from '@streamerson/core';
import { WebSocketServer } from '../../../src/wssapi';

const port = Number(process.env['WSS_FIXTURE_PORT']);
const topicName = process.env['WSS_FIXTURE_TOPIC'];
if (!port || !topicName) {
  console.error('WSS_FIXTURE_PORT and WSS_FIXTURE_TOPIC are required');
  process.exit(2);
}

const topic = new Topic({ namespace: 'wss-itest', topic: topicName });
const wss = new WebSocketServer({ port });
await wss.streamRoute('/echo', 'itest', topic, { authenticate: () => true });
await wss.listen();
console.log('READY');

for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes('stop')) {
    wss.stop();
    console.log('STOPPED');
    break;
  }
}
