import Fastify from 'fastify'
import {CreateGatewayPlugin} from '../../src/stream-plugin'
import {StreamingDataSource, StreamMessageFlowModes, StreamOptions} from '@streamerson/core';
import test from 'node:test';
import * as assert from 'node:assert';

const logger = console as any;
const defaultMeta:StreamOptions = {
    redisConfiguration: {
        host: 'localhost',
        port: 6379
    },
    channels: {
        readChannel: new StreamingDataSource(),
        writeChannel: new StreamingDataSource()
    },
    streamKey: '',
    meta: {
        namespace: '',
        mode: 'ORDERED' as StreamMessageFlowModes,
        sharded: false
    }
}

test('that loads the plugin', async ()=>{
    const server = Fastify();
    await server.register(CreateGatewayPlugin({
        logger,
        defaultMeta,
        routes: [{
            url: '/wat',
            meta: defaultMeta.meta,
            method: 'POST',
            messageType: 'test'
        }]
    }));
    assert.notEqual(server, undefined);
});