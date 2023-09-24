import { WebSocketServer } from '../../src'
import test from 'node:test';
import * as assert from 'node:assert';

test('we can create a websocket server', async ()=>{
    const server = new WebSocketServer();
    assert.notEqual(server, undefined);
});