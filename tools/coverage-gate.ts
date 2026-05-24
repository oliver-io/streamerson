#!/usr/bin/env bun
/**
 * Per-module coverage gate. Runs a test scope under Bun coverage (lcov), parses the
 * report for one or more TARGET source files, and fails (non-zero exit) unless each is
 * at 100% LINE coverage — printing the uncovered line numbers when not.
 *
 * Why line coverage: Bun's lcov emits only summary FNF/FNH for functions (no per-`FN`
 * records) and double-counts an anonymous arrow, so `FNH` sticks at one below `FNF`
 * even when every function body executes (line coverage proves that). Lines are the
 * reliable, meaningful metric here; function counts are reported for information only.
 *
 * Usage:
 *   bun tools/coverage-gate.ts [--scope <test path>] [--file <src path suffix> ...]
 * Defaults: scope = packages/core/test, file = packages/core/src/datasource/streamable.ts
 *
 * The default `test:coverage:reader` package script wires the stream-reader module.
 */
import { spawnSync } from 'child_process';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
function opt(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const scope = opt('--scope', 'packages/core/test');
const targets = args.reduce<string[]>((acc, a, i) => (a === '--file' && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
if (targets.length === 0) targets.push('packages/core/src/datasource/streamable.ts');

const norm = (p: string) => p.replace(/\\/g, '/');

const covDir = mkdtempSync(join(tmpdir(), 'streamerson-cov-'));
try {
  console.log(`coverage-gate: running \`bun test ${scope}\` under coverage…`);
  const run = spawnSync('bun', ['test', scope, '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${covDir}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
  });
  if (run.status !== 0) {
    console.error(`coverage-gate: test run failed (exit ${run.status}). Coverage not evaluated.`);
    process.exit(run.status ?? 1);
  }

  const lcov = readFileSync(join(covDir, 'lcov.info'), 'utf8');
  const records = lcov.split('end_of_record');

  let failed = false;
  for (const target of targets) {
    const want = norm(target);
    const rec = records.find((r) => {
      const sf = r.split('\n').find((l) => l.startsWith('SF:'));
      return sf ? norm(sf.slice(3).trim()).endsWith(want) : false;
    });
    if (!rec) {
      console.error(`coverage-gate: FAIL — no coverage record for ${target} (was it loaded by ${scope}?).`);
      failed = true;
      continue;
    }
    const num = (re: RegExp) => { const m = rec.match(re); return m ? Number(m[1]) : 0; };
    const LF = num(/LF:(\d+)/), LH = num(/LH:(\d+)/), FNF = num(/FNF:(\d+)/), FNH = num(/FNH:(\d+)/);
    const uncovered = rec.split('\n')
      .map((l) => l.match(/^DA:(\d+),(\d+)/))
      .filter((m): m is RegExpMatchArray => !!m && m[2] === '0')
      .map((m) => m[1]);

    const linePct = LF ? ((LH / LF) * 100).toFixed(2) : '0.00';
    if (LH === LF && LF > 0) {
      console.log(`coverage-gate: PASS  ${target} — lines ${LH}/${LF} (100%), funcs ${FNH}/${FNF}`);
    } else {
      console.error(`coverage-gate: FAIL  ${target} — lines ${LH}/${LF} (${linePct}%); uncovered: ${uncovered.join(', ') || '(none reported)'}`);
      failed = true;
    }
  }

  console.log(failed ? 'coverage-gate: 100% line coverage NOT met.' : 'coverage-gate: all targets at 100% line coverage.');
  process.exit(failed ? 1 : 0);
} finally {
  try { rmSync(covDir, { recursive: true, force: true }); } catch { /* */ }
}
