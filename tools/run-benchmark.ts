import {glob} from 'glob';
import minimist from 'minimist';
import path from 'path';
import {execSync} from 'child_process';

type CLIOptions = {
  report?: boolean,
  build?: boolean,
  exec?: boolean,
  target: string
}

async function runAllBenchmarksAndMaybeCollectResults(options: CLIOptions) {
  const appFiles: Array<string> = await glob(`./packages/benchmarking/src/**/*benchmark.ts`);
  if (!appFiles.length) {
    throw new Error("No such directory found");
  }

  for (const _appFile of appFiles) {
    const appFile = path.posix.resolve(_appFile);
    const dirname = path.basename(path.dirname(appFile));
    if (options.target && !options.target.includes(dirname)) {
      continue;
    }

    execSync(`yarn benchmark --build --target=${dirname}`, {stdio: 'inherit'});
    try {
      await runSingleBenchmark({
        ...options,
        target: dirname
      });
    } catch(err) {
      console.error(err);
    }
  }

  execSync('yarn build:summary', {
    cwd: path.resolve('./packages/benchmarking'), stdio: 'inherit'
  });
}

async function runSingleBenchmark(options: CLIOptions) {
  try {
    const buildReport = options.report ?? true;
    const appFiles: Array<string> = await glob(`./packages/benchmarking/src/**/*benchmark.ts`);
    if (!appFiles.length) {
      throw new Error("No such directory found");
    }

    const exec = options.exec ?? false;

    if (!exec && !options.build) {
      throw new Error("No action specified; must be one or both of --build or --exec");
    }

    for (const _appFile of appFiles) {
      const appFile = path.posix.resolve(_appFile);
      const directory = path.basename(path.dirname(appFile));
      if (options.target && !options.target.includes(directory)) {
        continue;
      }

      const
        STREAMERSON_IMAGE_TARGET = `streamerson/benchmarking/${directory}:latest`;
      const STREAMERSON_BENCHMARK_APP_TARGET = directory;
      const env = {
        ...process.env,
        STREAMERSON_IMAGE_TARGET,
        STREAMERSON_BENCHMARK_APP_TARGET,
        STREAMERSON_PROJECT: directory
      };

      // if the directory has its own app.yaml, then we need to use that instead of the default
      const [projectDockerFile] = await glob(`./packages/benchmarking/src/${directory}/app.dockerfile`);
      const [projectComposeFile] = await glob(`./packages/benchmarking/src/${directory}/app.yaml`);

      if (options.build) {
        const buildCommands = [
          ...(options.build ? [
            // The base image, which is just the `benchmarking` monorepo package with its dependencies already built:
            `docker build -t streamerson/benchmarking:latest . -f ./packages/benchmarking/build/benchmarking.dockerfile`,
            // The target image, i.e. the benchmarking app
            `docker build --build-arg TARGET=${directory} -t streamerson/benchmarking/${directory}:latest . -f ${projectDockerFile ?? './packages/benchmarking/build/app.dockerfile'}`
          ] : [])
        ];

        for (const cmd of buildCommands) {
          execSync(cmd, {
            stdio: 'inherit', env
          });
        }
      }

      if (options.exec) {
        const executeCommands = [
          `echo "Starting benchmark for ${directory}"`,
          `docker compose -p ${directory} -f ./build/stack.yaml -f ${projectComposeFile ?? './build/app.yaml'} up --abort-on-container-exit --force-recreate --renew-anon-volumes`,
          ...(buildReport ? [
            `docker cp ${directory}-benchmarking-1:/app/benchmarking/benchmark-report.json ./_reports/${directory}-report.json`,
          ] : [])
        ];

        for (const cmd of executeCommands) {
          execSync(cmd, {
            cwd: path.resolve('./packages/benchmarking'), stdio: 'inherit', env
          });
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  const args = minimist(process.argv.slice(2), {});
  if (!args.target) {
    await runAllBenchmarksAndMaybeCollectResults({
      ...args,
      target: "*"
    });
  } else {
    await runSingleBenchmark({
      ...args,
      target: args.target
    });
  }
}

run().catch(console.error);
