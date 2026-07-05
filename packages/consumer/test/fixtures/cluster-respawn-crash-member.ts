// Bun Worker entry for the failed-respawn RED test: spawn #1 is a healthy member
// (with a `boom` handler that hard-crashes the thread), spawn #2 exits BEFORE
// signalling ready (a respawn that never comes up), and spawn #3+ is healthy again.
// The spawn counter is a file (path via RESPAWN_FIXTURE_FILE, inherited env) so it
// survives worker-thread deaths.
import fs from 'node:fs';
import { ConsumerGroupMember, runClusterMember } from '../../src/index';

runClusterMember((params) => {
  const counterFile = process.env['RESPAWN_FIXTURE_FILE'];
  if (!counterFile) throw new Error('RESPAWN_FIXTURE_FILE is required');
  let spawn = 0;
  try { spawn = Number(fs.readFileSync(counterFile, 'utf8')) || 0; } catch { /* first spawn */ }
  spawn++;
  fs.writeFileSync(counterFile, String(spawn));

  if (spawn === 2) {
    // The respawn crashes before ever becoming ready.
    process.exit(1);
  }

  return new ConsumerGroupMember(
    {
      ...params.connectionSettings,
      eventMap: {
        echo: async () => ({ ok: true }),
        boom: async () => { process.exit(1); },
      },
    },
    params.memberSettings,
  );
});
