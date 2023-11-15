import {execSync} from "child_process";
import * as process from "process";
import minimist from 'minimist';
const args = minimist(process.argv.slice(2));

async function build() {
  const target = args.filename;
  if (!target) {
    throw new Error('Must specify target filename');
  }

  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: "./admin.GCP.json"
  };
  const commands: Array<string> = [];
  commands.push(`
    gcloud storage sign-url gs://streamerson-benchmarks/${target}.json --http-verb=PUT --duration=7d --private-key-file=./admin.GCP.json --region=us-central1
  `);

  const urls:Array<string> = [];

  for (const command of commands.map(s => s.trim())) {
    const output = execSync(command, { env });

    const commandResponse = output.toString();

    if (commandResponse.indexOf('https://') === -1) {
      console.log(commandResponse);
      throw new Error('Could not find URL in output');
    }

    const i = commandResponse.indexOf('https://');
    const l = commandResponse.length;
    urls.push(commandResponse.substring(i, l).trim());
  }

  console.log(urls);
}

build().catch(console.error);
