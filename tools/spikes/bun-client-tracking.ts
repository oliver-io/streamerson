/**
 * SPIKE: can we do Redis client-side-caching invalidation natively on Bun's
 * client (no node-redis `clientTracking` helper)? node-redis's clientTracking()
 * is just `CLIENT TRACKING ON REDIRECT <id>`, which we can issue via send().
 * Flow: subscriber listens on __redis__:invalidate; tracked connection enables
 * tracking REDIRECTed to the subscriber; a mutation from a 3rd connection should
 * push an invalidation for the tracked key.
 *
 * Run (Redis on localhost:6379):  bun tools/spikes/bun-client-tracking.ts
 */
import { RedisClient } from 'bun';

const URL = process.env['STREAMERSON_REDIS_URL'] ?? 'redis://localhost:6379';
const key = 'tracking:spike:key';

async function main() {
  const cached = new RedisClient(URL);      // reads here get tracked
  const invalidator = new RedisClient(URL); // receives invalidation pushes
  const writer = new RedisClient(URL);      // mutates the key

  await Promise.all([cached.connect(), invalidator.connect(), writer.connect()]);
  await writer.send('SET', [key, 'v1']);

  const invalidated: string[] = [];
  await invalidator.subscribe('__redis__:invalidate', (message: string, channel: string) => {
    console.log('invalidation push:', JSON.stringify(message), 'on', channel);
    invalidated.push(String(message));
  });

  const id = await invalidator.send('CLIENT', ['ID']);
  console.log('subscriber CLIENT ID:', id);

  const track = await cached.send('CLIENT', ['TRACKING', 'ON', 'REDIRECT', String(id)]);
  console.log('CLIENT TRACKING ON REDIRECT ->', track);

  console.log('tracked GET ->', await cached.send('GET', [key])); // server now tracks `key` for `cached`
  await writer.send('SET', [key, 'v2']);                          // should trigger invalidation
  await Bun.sleep(600);

  const ok = invalidated.some((m) => m.includes(key));
  console.log('\n================ VERDICT ================');
  console.log('invalidations received:', JSON.stringify(invalidated));
  console.log(ok
    ? 'PASS — Bun can drive client-side-cache invalidation via raw send() + subscribe'
    : 'FAIL — no invalidation received; keep node-redis for state-machine');

  cached.close(); invalidator.close(); writer.close();
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error('SPIKE THREW:', e); process.exit(1); });
