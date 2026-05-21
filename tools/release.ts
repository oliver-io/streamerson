/**
 * Bun-native release pipeline (replaces the old nx/lerna/npm flow).
 *
 * Builds compiled, publishable packages and publishes them with `bun publish`.
 * Each `dist/packages/<name>` gets a generated package.json whose `main`/`types`
 * point at the emitted `index.js`/`index.d.ts`, with internal `@streamerson/*`
 * dependencies injected at their current versions.
 *
 *   bun ./tools/release.ts            # build + stage + `bun publish --dry-run` (pack only)
 *   bun ./tools/release.ts --publish  # build + stage + `bun publish`
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'fs';
import path from 'path';

// Publishable packages (must match tsconfig.build.json), with internal deps.
const INTERNAL_DEPS: Record<string, string[]> = {
  core: [],
  emitter: [],
  'test-utils': [],
  consumer: ['core'],
  'gateway-fastify': ['core'],
  'gateway-wss': ['core'],
};

const shouldPublish = process.argv.includes('--publish');

function run(cmd: string, cwd?: string) {
  console.log(`> ${cmd}${cwd ? `  (in ${path.relative(process.cwd(), cwd)})` : ''}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

function srcPkg(name: string) {
  return JSON.parse(readFileSync(path.resolve('packages', name, 'package.json'), 'utf8'));
}

// 1. Compile every publishable package (emits dist/packages/<name>/index.{js,d.ts}).
run('tsc -b tsconfig.build.json');

// 2. Stage a publishable package.json + README into each dist dir.
const versions = Object.fromEntries(Object.keys(INTERNAL_DEPS).map((n) => [n, srcPkg(n).version]));

for (const name of Object.keys(INTERNAL_DEPS)) {
  const distDir = path.resolve('dist/packages', name);
  const pkg = srcPkg(name);

  const dependencies: Record<string, string> = { ...(pkg.dependencies ?? {}) };
  for (const dep of INTERNAL_DEPS[name]) {
    dependencies[`@streamerson/${dep}`] = `^${versions[dep]}`;
  }

  const distPkg = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    author: pkg.author,
    type: pkg.type ?? 'commonjs',
    main: './index.js',
    types: './index.d.ts',
    dependencies,
  };

  writeFileSync(path.join(distDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');
  const readme = path.resolve('packages', name, 'README.md');
  if (existsSync(readme)) {
    copyFileSync(readme, path.join(distDir, 'README.md'));
  }
  // The incremental build cache is not part of the published package.
  rmSync(path.join(distDir, '.tsbuildinfo'), { force: true });
  console.log(`staged ${pkg.name}@${pkg.version}`);
}

// 3. Publish (or pack via --dry-run).
for (const name of Object.keys(INTERNAL_DEPS)) {
  run(`bun publish${shouldPublish ? '' : ' --dry-run'}`, path.resolve('dist/packages', name));
}

console.log(shouldPublish ? '\nPublished.' : '\nDry run complete (no packages published; pass --publish to release).');
