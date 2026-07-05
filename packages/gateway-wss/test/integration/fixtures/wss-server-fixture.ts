/**
 * Subprocess fixture for wss resilience tests: a real WSS gateway on
 * WSS_FIXTURE_PORT bridging /echo to WSS_FIXTURE_TOPIC. Prints READY when
 * listening. The parent test injects the failure (e.g. WRONGTYPEs the consumer
 * stream key) and observes whether this process survives.
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
