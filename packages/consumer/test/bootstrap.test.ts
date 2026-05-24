import {StreamMessageFlowModes} from '@streamerson/core';
import { test, expect } from "bun:test";
import {ConsumerGroupCoordinator} from "../src/group";

test('a consumer group can be created (idempotently)', async () => {
    const coordinator = new ConsumerGroupCoordinator({
      topic: {
        topic: 'test',
        namespace: 'test',
        mode: 'ORDERED' as StreamMessageFlowModes
      },
    }, {
        name: 'test',
        count: 1,
        processingTimeout: 0,
        idleTimeout: 0
    });

    await coordinator.connectAndListen();
    await coordinator.create();
    // Re-creating an existing group is not an error and reports already-existed.
    const second = await coordinator.create();
    expect(second.created).toBe(false);
    await coordinator.disconnect();
});
