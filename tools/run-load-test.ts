import minimist from 'minimist';
import path from 'path';
import {execSync} from 'child_process';
import {stat} from 'fs/promises';

type CLIOptions = {
  report?: boolean,
  build?: boolean,
  exec?: boolean
  cluster?: boolean;
  target: string
} & ({ framework: true, control: false } | { control: true, framework: false });

const dockerUpOptions = '--abort-on-container-exit --force-recreate --renew-anon-volumes';

async function runSingleLoadTest(args: CLIOptions) {
  const loadTestingDirectory = './packages/benchmarking/src/loadtests';
  const targetFile = path.resolve(`${loadTestingDirectory}/artillery/${args.target}.yaml`);
  const modePrefix = args.framework ? 'streamerson' : 'fastify';
  const microserviceFile = args.cluster ?
    path.resolve(`${loadTestingDirectory}/streamerson-group-cluster.ts`) :
    path.resolve(`${loadTestingDirectory}/${modePrefix}-microservice.ts`);
  const gatewayFile = path.resolve(`${loadTestingDirectory}/${modePrefix}-gateway.ts`);
  if (!await stat(microserviceFile)) {
    throw new Error(`No gateway file for load test (${microserviceFile})`);
  } else if (!await stat(gatewayFile)) {
    throw new Error(`No service file for load test (${gatewayFile})`);
  } else if (!await stat(targetFile)) {
    throw new Error(`No target artillery script for load test (target=${args.target})`);
  }

  const loadTestName = `${args.target}-${modePrefix}`;
  const STREAMERSON_BENCHMARK_DIRECTORY = 'loadtests';
  const env = {
    ...process.env,
    STREAMERSON_BENCHMARK_DIRECTORY,
    STREAMERSON_BENCHMARK_GATEWAY_FILE_TARGET: `${modePrefix}-gateway`,
    STREAMERSON_BENCHMARK_MICROSERVICE_FILE_TARGET: args.cluster ? `${modePrefix}-group-cluster` : `${modePrefix}-microservice`,
    STREAMERSON_BENCHMARK_REPORT_PATH: `${modePrefix}-${args.target}-report.json`,
    STREAMERSON_BENCHMARK_TARGET: args.target
  };

  const baseImageName = 'streamerson/benchmarking:latest';
  const baseImagePath = path.resolve('./packages/benchmarking/build/base.dockerfile');

  if (args.build ?? true) {
    execSync(`docker build -t ${baseImageName} . -f ${baseImagePath}`, {
      stdio: 'inherit', env
    });
  }

  const executeCommands = [
    `echo "Initiating Dockerized loadtest for ${args.target} (${modePrefix})"`,
    `docker compose -f ./build/compose.redis.yaml -f ./build/compose.load.yaml up ${dockerUpOptions}`,
  ];

  if (args.exec ?? true) {
    for (const cmd of executeCommands) {
      console.log(cmd);
      execSync(cmd, {
        cwd: path.resolve('./packages/benchmarking'), stdio: 'inherit', env
      });
    }
  }
}

async function run() {
  const args = minimist<CLIOptions>(process.argv.slice(2), {
    string: ['target'],
    boolean: ['framework', 'control', 'cluster']
  });

  if (!args.framework && !args.control) {
    throw new Error("No benchmark specified; must be one or both of --framework or --control");
  }

  if (!args.target) {
    throw new Error("No target specified");
  } else {
    await runSingleLoadTest({
      ...args,
      target: args.target
    });
  }
}

run().catch(console.error);
