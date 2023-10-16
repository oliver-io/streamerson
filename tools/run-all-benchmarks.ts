import path from 'path';
import {execSync} from 'child_process';
import {glob} from 'glob';
import minimist from 'minimist';

async function runAllBenchmarksAndMaybeCollectResults() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['collect']
  });

  const appFiles:Array<string> = await glob(`./packages/benchmarking/src/**/*benchmark.ts`);
  if (!appFiles.length) {
    throw new Error("No such directory found");
  }

  const executionCommands:Array<string> = [];

  for (const _appFile of appFiles) {
    const appFile = path.posix.resolve(_appFile);
    const dirname = path.basename(path.dirname(appFile));
    if (args.target && !args.target.includes(dirname)) {
      continue;
    }

    execSync(`yarn benchmark --build --target=${dirname}`, { stdio: 'inherit' });
    executionCommands.push(`yarn benchmark --exec --target=${dirname}`);
  }

  for (const cmd of executionCommands) {
    execSync(cmd, { stdio: 'inherit' });
  }

  execSync('yarn build:summary', {
    cwd: path.resolve('./packages/benchmarking'), stdio: 'inherit'
  });
}

runAllBenchmarksAndMaybeCollectResults().catch(console.error);
