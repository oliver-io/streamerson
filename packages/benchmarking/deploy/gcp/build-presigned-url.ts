import {execSync} from "child_process";
import * as process from "process";

async function build() {
  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: "./admin.GCP.json"
  };
  const commands: Array<string> = [];
  commands.push(`
    gcloud storage sign-url gs://streamerson-benchmarks/small-streamerson-report.json --http-verb=PUT --duration=7d --private-key-file=./admin.GCP.json
  `);

  const urls:Array<string> = [];

  for (const command of commands.map(s => s.trim())) {
    const output = execSync(command);

    const urlContent = output.toString();

    const i = urlContent.indexOf('https://');
    const l = urlContent.length;
    urls.push(urlContent.substring(i, l).trim());
  }

  console.log(urls);
}

build().catch(console.error);
