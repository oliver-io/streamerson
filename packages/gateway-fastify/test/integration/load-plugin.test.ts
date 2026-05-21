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
  assert.notEqual(server, undefined);
  await server.close();
});
