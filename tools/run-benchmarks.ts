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
    const appFiles:Array<string> = await glob(`./packages/benchmarking/src/reference/**/app.yaml`);
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

      const [_dockerfile] = await glob(`./packages/benchmarking/src/reference/${dirname}/**.dockerfile`);
      const dockerfile = path.posix.resolve(_dockerfile);
      if (!dockerfile) {
        throw new Error(`No dockerfile found for ${dirname}`);
      }

      const commands = [
        ... (args.build ? [
          `docker build -t ${dirname} . -f ${dockerfile}`
        ] : []),
        'cd ./packages/benchmarking/src/reference',
        `docker compose -f redis.yaml -f ${appFile} up`
      ];

      const command = commands.join(' && ');
      console.log(command)

      const result = execSync(command, { stdio: 'inherit' });
      console.log(result);
    }
  } catch(err) {
    console.error(err);
  }
}

run().catch(console.error);
