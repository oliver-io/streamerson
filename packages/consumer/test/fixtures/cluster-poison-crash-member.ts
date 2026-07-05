// Bun Worker entry for the hard-poison crash-loop test: a 'work' message with
// payload.poison hard-kills the worker thread (after INCRing a Redis run counter,
// key via POISON_FIXTURE_KEY inherited env, so the parent can count crashes across
// worker deaths); any other 'work' message echoes. A side connection does the INCR
// because the member's own channels are mid-read when the handler runs.
import { StreamingDataSource } from '@streamerson/core';
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember(async (params) => {
  const counterKey = process.env['POISON_FIXTURE_KEY'];
  if (!counterKey) throw new Error('POISON_FIXTURE_KEY is required');
  const side = new StreamingDataSource({
    host: params.connectionSettings.redisConfiguration?.host,
    port: params.connectionSettings.redisConfiguration?.port,
  });
  await side.connect();
  await side.client.send('INCR', [`${counterKey}:spawns`]);

  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        work: async (e: any) => {
          if (e.payload?.poison) {
            await side.client.send('INCR', [`${counterKey}:poison-runs`]);
            process.exit(1);
          }
          return { ok: true, echoed: e.payload?.hi };
        },
      },
    },
    params.memberSettings,
  );
});
