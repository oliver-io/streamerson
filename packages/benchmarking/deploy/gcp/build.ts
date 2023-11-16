import {execSync} from "child_process";
import * as process from "process";
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  boolean: ['publish']
});

async function build() {
  const env = {
    ...process.env
  };
  const commands: Array<string> = [];
  const baseImage = "streamerson/benchmarking";
  const microserviceImage = "0liveri0/streamerson-microservice"
  const redisImage = "0liveri0/streamerson-redis";
  const loadtestImage = "0liveri0/streamerson-loadtest";

  commands.push(`
    docker build -t ${baseImage}:latest ../../../../ -f ../../build/base.dockerfile
  `, `
    docker build -t ${microserviceImage}:latest . -f ../../build/app.dockerfile
  `, `
    docker build -t ${redisImage}:latest ../../build -f ../../build/redis.dockerfile
  `, `
    docker build -t ${loadtestImage}:latest ../../../../ -f ../../build/app.loadtest.dockerfile
  `, ... (args.publish ? [`
      docker push ${microserviceImage}:latest
    `, `
      docker push ${redisImage}:latest
    `, `
      docker push ${loadtestImage}:latest
  `] : []));

  for (const command of commands.map(s => s.trim())) {
    execSync(command, {
      stdio: 'inherit', env
    });
  }
}

build().catch(console.error);
