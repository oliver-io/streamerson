import {execSync} from "child_process";

async function build() {
  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: "key.GCP.json",
  };
  const dockerCommand = `
    gcloud compute scp ./scp/wat.txt microservice-01499be9:WUT.txt
  `.trim();
  execSync(dockerCommand, {
    stdio: 'inherit', env
  });

}

build().catch(console.error);
