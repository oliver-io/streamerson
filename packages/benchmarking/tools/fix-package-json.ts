import minimist from 'minimist';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const args = minimist(process.argv.slice(2), {
  string: ['target']
});

export async function fixPackageJson() {
  const packages = [
    { package: "@streamerson/core", pathFromSubpackage: "../core/src/index" },
    { package: "@streamerson/consumer", pathFromSubpackage: "../consumer/src/index" },
    { package: "@streamerson/gateway-fastify", pathFromSubpackage: "../gateway-fastify/src/index" }
  ]

  const jsonFile = await readFile(resolve(args.target));
  const json = JSON.parse(jsonFile.toString());
  json.dependencies = {
    ...json.dependencies,
    ...packages.reduce((acc, curr) => {
      acc[curr.package] = `file:${curr.pathFromSubpackage}`;
      return acc;
    }, {})
  }
  await writeFile(resolve(args.target), JSON.stringify(json, null, 2));
}

fixPackageJson().catch(console.error);
