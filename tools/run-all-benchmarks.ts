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
  } else {
    console.log(appFiles);
  }

  for (const _appFile of appFiles) {
    const appFile = path.posix.resolve(_appFile);
    const dirname = path.basename(path.dirname(appFile));
    if (args.target && !args.target.includes(dirname)) {
      continue;
    }

    const result = execSync(`yarn benchmark --target=${dirname}`, { stdio: 'inherit' });
    // After we run the benchmark, we should run a `docker cp` of some sort in order to extract
    // a TODO: file from the docker container containing an aggregate of its JSON.
    // Then we can take all the executed benchmarks, and aggregate them into a single JSON file
    // and console.table that here:
    console.log(result);
  }
}
