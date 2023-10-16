import {glob} from 'glob';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'path';
import {StepEvent} from "./iterateTimedEvents";
import {Align, getMarkdownTable} from 'markdown-table-ts';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

type ExperimentType = 'control' | 'experiment';

function makeMarkdownTable(results: Awaited<ReturnType<typeof summarizeResults>>) {
  const __headers = Object.keys(results[Object.keys(results)[0]]);
  const _headers = [...__headers];
  for (let i = 0; i < _headers.length; i++) {
    _headers[i] = `**${_headers[i]}** (ms)`;
  }
  return getMarkdownTable({
    table: {
      head: ['Test Case', ..._headers, 'Framework Overhead'],
      body: Object.keys(results).map((key) => {
        const row = results[key];
        const headers = __headers as Array<keyof typeof row>;
        const hasTiming = (row["control"] !== 'n/a' && row["experiment"] !== 'n/a');
        return [
          key,
          row["control"].toString(),
          row["experiment"].toString(),
          (row["control"] === 'n/a' || row["experiment"] === 'n/a') ?
            'n/a' :
            `~ ${((1 - (row["control"] / (row["experiment"]))) * 100).toFixed(1)}%`
        ];
      }),
    },
    alignment: [Align.Left, Align.Center, Align.Center],
  });
}

export async function summarizeResults() {
  const results: Record<string, {
    control: number | 'n/a',
    experiment: number | 'n/a'
  }> = {};

  // gather up all the results files in the _reports directory:
  const filePaths = await glob('**/_reports/*.json');
  const $readReports = filePaths.map((n: string) => path.resolve(n)).map((file) => {
    return readFile(file);
  })
  const fileContents = (await Promise.all($readReports)).map(f => JSON.parse(f.toString()));

  // for each file, read it in and parse it:
  for (const report of fileContents) {
    // Error if we did not finish:
    if (!report.timingEvents.find((step: StepEvent) => step.step === 'finalized')) {
      throw new Error(`Did not finish benchmarking`);
    }

    const experimentType: ExperimentType = report.experimentType;
    const finished = report.timingEvents.find((step: StepEvent) => step.step === 'finished');
    const eventName = finished.name;

    if (!experimentType) {
      throw new Error(`No experiment type found for ${eventName}`);
    }

    if (!Object.prototype.hasOwnProperty.call(finished, 'duration')) {
      throw new Error(`No duration found for ${eventName}`);
    }

    if (!results[eventName]) {
      results[eventName] = {
        control: 'n/a',
        experiment: 'n/a'
      }
    }

    results[eventName][experimentType] = finished.duration;
  }

  // console.table(results);
  return results;
}

async function run() {
  const results = await summarizeResults();
  console.table(results);
  if (args.write) {
    const table = makeMarkdownTable(results);
    await writeFile('./_reports/summary.md', table);
  } else {
    console.warn('Not writing results to file. Use --write to write results to file.')
  }
}

run().catch(console.error);
