import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ConsumerGroupCoordinator } from '../src/group';
import { REDIS, testRig } from './harness';

const rig = testRig();

beforeAll(() => rig.connect());
afterAll(() => rig.teardown());

test('a consumer group can be created (idempotently)', async () => {
    const coordinator = rig.track(new ConsumerGroupCoordinator({
      topic: rig.topic('bootstrap'),
      redisConfiguration: REDIS,
    }, {
        name: 'test',
        count: 1,
        processingTimeout: 0,
        idleTimeout: 0
    }));

    await coordinator.connectAndListen();
    const first = await coordinator.create();
    expect(first.created).toBe(true);
    // Re-creating an existing group is not an error and reports already-existed.
    const second = await coordinator.create();
    expect(second.created).toBe(false);
});
