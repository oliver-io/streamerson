import {glob} from 'glob';
import minimist from 'minimist';
import path from 'path';
import {execSync} from 'child_process';

const args = minimist(process.argv.slice(2), {});

if (!args.target) {
  throw new Error("No target specified");
}

async function run() {
  try {
    const buildReport = args.report ?? true;
    const appFiles: Array<string> = await glob(`./packages/benchmarking/src/**/*benchmark.ts`);
    if (!appFiles.length) {
      throw new Error("No such directory found");
    }

    const exec = args.exec ?? false;

    if (!exec && !args.build) {
      throw new Error("No action specified; must be one or both of --build or --exec");
    }

    for (const _appFile of appFiles) {
      const appFile = path.posix.resolve(_appFile);
      const directory = path.basename(path.dirname(appFile));
      if (args.target && !args.target.includes(directory)) {
        continue;
      }

      const STREAMERSON_IMAGE_TARGET = `streamerson/benchmarking/${directory}:latest`;
      const STREAMERSON_BENCHMARK_APP_TARGET = directory;
      const env = {
        ...process.env,
        STREAMERSON_IMAGE_TARGET,
        STREAMERSON_BENCHMARK_APP_TARGET,
        STREAMERSON_PROJECT: directory
      };

      const buildBaseImageCmd = "docker build -t streamerson/benchmarking:latest . -f ./packages/benchmarking/build/benchmarking.dockerfile";
      const buildDefaultImageCmd = `docker build --build-arg TARGET=${
        directory
      } -t streamerson/benchmarking/${
        directory
      }:latest . -f ./packages/benchmarking/build/app.dockerfile`;
      // if the directory has its own app.yaml, then we need to use that instead of the default
      const [projectDockerFile] = await glob(`./packages/benchmarking/src/${directory}/app.dockerfile`);
      const [projectComposeFile] = await glob(`./packages/benchmarking/src/${directory}/app.dockerfile`);


      if (args.build) {
        const buildCommands = [
          ...(args.build ? [
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

      if (args.exec) {
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

run().catch(console.error);
