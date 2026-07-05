/**
 * LEGACY SMOKE TEST — despite the `integration/` path, this only constructs the class
 * (no sockets, no Redis, near-zero behavioral value). Superseded by the real end-to-end
 * coverage in `wss-roundtrip.test.ts`. Kept in place — not renamed/deleted — so git
 * history and prior discussion stay cheap to follow. Do not extend; add new coverage
 * to the real integration files instead.
 */
import { WebSocketServer } from '../../src'
import { test } from "bun:test";
import * as assert from 'node:assert';

test('we can create a websocket server', async ()=>{
    const server = new WebSocketServer();
    assert.notEqual(server, undefined);
});