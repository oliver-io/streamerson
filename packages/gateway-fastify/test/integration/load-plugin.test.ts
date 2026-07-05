import Fastify from 'fastify';
import { CreateGatewayPlugin } from '../../src/stream-plugin';
import { Topic } from '@streamerson/core';
import { test } from 'bun:test';
import * as assert from 'node:assert';

test('the gateway plugin loads and registers its routes', async () => {
  const server = Fastify();
  await server.register(CreateGatewayPlugin({
    topic: new Topic('test'),
    routes: [{ url: '/wat', method: 'POST', messageType: 'test' }],
  }));
  await server.ready();
  // Registration actually mounted the declared route (not just "didn't throw").
  assert.equal(server.hasRoute({ method: 'POST', url: '/wat' }), true);
  assert.equal(server.hasRoute({ method: 'GET', url: '/wat' }), false);
  // And the armed readers don't wedge shutdown: close resolves cleanly.
  await server.close();
});
