/**
 * Subprocess fixture for wss-auth-edges throw-path tests: a real WSS gateway on
 * WSS_FIXTURE_PORT with
 *   /open      -> WSS_FIXTURE_TOPIC        (authenticate: true, no hooks)
 *   /throwauth -> WSS_FIXTURE_TOPIC_THROW  (authenticate throws)
 *   /hookthrow -> WSS_FIXTURE_TOPIC_HOOK   (onMessage hook throws)
 * Prints READY when listening. The parent test drives the throwing routes and
 * observes whether this process survives and keeps serving.
 */
import { Topic } from '@streamerson/core';
import { WebSocketServer } from '../../../src/wssapi';

const port = Number(process.env['WSS_FIXTURE_PORT']);
const topicName = process.env['WSS_FIXTURE_TOPIC'];
const throwTopicName = process.env['WSS_FIXTURE_TOPIC_THROW'];
const hookTopicName = process.env['WSS_FIXTURE_TOPIC_HOOK'];
if (!port || !topicName || !throwTopicName || !hookTopicName) {
  console.error('WSS_FIXTURE_PORT, WSS_FIXTURE_TOPIC, WSS_FIXTURE_TOPIC_THROW and WSS_FIXTURE_TOPIC_HOOK are required');
  process.exit(2);
}

const wss = new WebSocketServer({ port });
await wss.streamRoute('/open', 'itest', new Topic({ namespace: 'wss-itest', topic: topicName }), {
  authenticate: () => true,
});
await wss.streamRoute('/throwauth', 'itest', new Topic({ namespace: 'wss-itest', topic: throwTopicName }), {
  authenticate: () => { throw new Error('boom-auth'); },
});
await wss.streamRoute('/hookthrow', 'itest', new Topic({ namespace: 'wss-itest', topic: hookTopicName }), {
  authenticate: () => true,
  onMessage: () => { throw new Error('boom-onmessage'); },
});
await wss.listen();
console.log('READY');
