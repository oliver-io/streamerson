import {glob} from 'glob';
import minimist from 'minimist';
import path from 'path';
import {execSync} from 'child_process';
import {
  definitions,
  environmentForDefinition,
  getDefinition
} from "@streamerson/benchmarking/src/core_modules/definitions";


type CLIOptions = {
  report?: boolean,
  build?: boolean,
  exec?: boolean
  buildBase?: boolean,
  folder: string
  file?: string;
} & ({ framework: true, control: false } | { control: true, framework: false });

const baseImageName = 'streamerson/benchmarking:latest';
function buildBaseImageCommand(baseImageName: string, baseImagePath: string) {
  return `docker build -t ${baseImageName} . -f ${baseImagePath}`
}

function buildBenchmarkImageCommand(directory: string, tag: string, dockerfilePath: string) {
  return `docker build --build-arg TARGET=${directory} -t ${tag} . -f ${dockerfilePath}`
}

async function getBaseImagePath() {
  const [filePath] = await glob(`./packages/benchmarking/src/**/base.dockerfile`);
  if (!filePath) {
    throw new Error("Base image dockerfile not found");
  }
}

const baseImagePath = path.resolve('./packages/benchmarking/build/base.dockerfile');

export async function runSingleBenchmark(options: CLIOptions, reportName: string, fileKey: string = "benchmark", envExtra: Record<string, string> = {}) {
  try {
    const buildReport = options.report ?? true;
    const appFiles: Array<string> = await glob(`./packages/benchmarking/src/**/*${fileKey}.ts`);
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
      if (options.folder && !options.folder.includes(directory)) {
        continue;
      }

      const STREAMERSON_IMAGE_TARGET = `streamerson/benchmarking/${directory}:latest`;
      const STREAMERSON_BENCHMARK_DIRECTORY = directory;
      const env = {
        ...process.env,
        STREAMERSON_IMAGE_TARGET,
        STREAMERSON_BENCHMARK_TARGET: options.folder,
        STREAMERSON_BENCHMARK_DIRECTORY,
        STREAMERSON_PROJECT: directory,
        ...envExtra
      };

      const benchmarkDockerFile = path.resolve('./packages/benchmarking/build/app.dockerfile');
      if (options.build) {
        // if the directory has its own compose.benchmark.yaml, then we need to use that instead of the default
        const [projectDockerFile] = await glob(`./packages/benchmarking/src/**/${directory}/benchmark.dockerfile`);
        const buildCommands = [
          ...(options.build ? [
            // The base image, which is just the `benchmarking` monorepo package with its dependencies already built:
            buildBaseImageCommand(baseImageName, baseImagePath),
            // The target image, i.e. the benchmarking app
            buildBenchmarkImageCommand(directory, STREAMERSON_IMAGE_TARGET, projectDockerFile ?? benchmarkDockerFile),
          ] : [])
        ];

        for (const cmd of buildCommands) {
          execSync(cmd, {
            stdio: 'inherit', env
          });
        }
      }

      if (options.exec) {
        const dockerUpOptions = '--abort-on-container-exit --force-recreate --renew-anon-volumes';
        const stackComposeFile = './build/compose.stack.yaml';
        const defaultComposeFile = './build/compose.benchmark.yaml';
        const [projectComposeFile] = await glob(`./packages/benchmarking/src/**/${directory}/benchmark.compose.yaml`);

        const targetedComposeFile = projectComposeFile ?? (
          appFile.includes('webapp') ? stackComposeFile :
            defaultComposeFile
        );

        const executeCommands = [
          `echo "Starting benchmark for ${directory}"`,
          `docker compose -f ./build/compose.redis.yaml -f ${targetedComposeFile} up ${dockerUpOptions}`,
          ...(buildReport ? [
            `docker cp build-benchmark-1:/app/benchmarking/benchmark-report.json ./_reports/${directory}/${reportName}`,
          ] : [])
        ];

        for (const cmd of executeCommands) {
          console.log(cmd);
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

const defs = Object.keys(definitions).map((d) => {
  return {
    name: d,
    ...getDefinition(d),
    ...environmentForDefinition(d, definitions[d])
  }
});

async function runAllBenchmarks() {
  const options = minimist(process.argv.slice(2)) as unknown as CLIOptions;

  for (const def of defs) {
    const test: 'read' | 'write' = def.read ? 'read' : 'write';
    let type: 'client' | 'framework' = options.framework ? 'framework' : 'client';
    let isStream = false;
    const target = `${test}-${isStream ? 'stream-' : ''}${type}`;
    await runSingleBenchmark({
        ...options,
        build: true,
        exec: true,
        report: true,
        folder: 'core_modules',
      },
      `${target}-report.json`,
      target,
      {
        ...environmentForDefinition(def.name, def),
        STREAMERSON_BENCHMARK_FILE_TARGET: target,
        STREAMERSON_BENCHMARK_DIRECTORY: 'core_modules',
        STREAMERSON_PROJECT: 'core_modules',
      }
    );
  }
}

async function run() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['report', 'build', 'exec'],
    string: ['target', 'file']
  }) as unknown as CLIOptions;

  await runAllBenchmarks();

  if (args.report) {
    execSync('yarn build:summary', {
      cwd: path.resolve('./packages/benchmarking'), stdio: 'inherit'
    });
  }
}

run().catch(console.error);
