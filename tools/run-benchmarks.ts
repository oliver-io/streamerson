import {glob} from 'glob';
import minimist from 'minimist';
import path from 'path';
import { execSync } from 'child_process';

const args = minimist(process.argv.slice(2), {

});

if (!args.target) {
  throw new Error("No target specified");
}

async function run() {
  try {
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

      // const [_dockerfile] = await glob(`./packages/benchmarking/src/reference/${dirname}/**.dockerfile`);
      // const dockerfile = path.posix.resolve(_dockerfile);
      // if (!dockerfile) {
      //   throw new Error(`No dockerfile found for ${dirname}`);
      // }

      const command = [
        ... (args.build ? [
          `docker build -t streamerson/benchmarking . -f ./packages/benchmarking/build/benchmarking.dockerfile`,
          `(docker build --build-arg TARGET=${dirname} -t streamerson/benchmarking/${dirname} . -f ./packages/benchmarking/build/app.dockerfile)`
        ] : []),
        "cd packages/benchmarking",
        `echo "Starting benchmark for ${dirname}"`,
        "docker compose -f ./build/stack.yaml -f ./build/app.yaml up"
      ].join(' && ');

      const result = execSync(command, { stdio: 'inherit', env: {
        ...process.env,
        STREAMERSON_IMAGE_TARGET: `streamerson/benchmarking/${dirname}:latest`,
        STREAMERSON_BENCHMARK_APP_TARGET: dirname,
        STREAMERSON_PROJECT_ROOT: path.posix.resolve('./packages/benchmarking')
      }});
      console.log(result);
    }
  } catch(err) {
    console.error(err);
  }
}

run().catch(console.error);
