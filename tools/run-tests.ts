import { glob } from 'glob';
import {getPackageMetadata} from "./get-package-metadata";
import { describe } from 'node:test';
const [_, __, target, filter] = process.argv;

if (!target) {
    throw new Error("No target specified");
}

(async () => {

  try {
    const { projectDirectory } = getPackageMetadata(target);
    const testFiles:Array<string> = await glob(`${projectDirectory}/**/*.test.ts`);
    for (const testFile of testFiles) {
      if (filter && !testFile.includes(filter)) {
        continue;
      }
      describe(`${testFile}`, async () => {
        await import(testFile);
      });
    }
  } catch(err) {
    console.error(err);
    throw new Error("Cannot read package.json");
  }
})().catch(console.error)
