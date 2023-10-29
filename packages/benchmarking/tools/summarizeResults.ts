import {glob} from 'glob';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'path';
import {StepEvent} from "../src/utils/iterateTimedEvents";
import {Align, getMarkdownTable} from 'markdown-table-ts';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

export type ExperimentType = 'control' | 'experiment' | 'stream' | 'iterator';

function makeMarkdownTable(results: Awaited<ReturnType<typeof summarizeResults>>) {
  const __headers = Object.keys(results[Object.keys(results)[0]]);
  const _headers = [...__headers];
  for (let i = 0; i < _headers.length; i++) {
    _headers[i] = `**${_headers[i]}** (ms)`;
  }
  return getMarkdownTable({
    table: {
      head: [
        'Test Case',
        _headers[0],
        _headers[1],
        'Base<br/>Overhead',
        _headers[2],
        'Stream<br/>Overhead',
        _headers[3],
        'Iterator<br/>Overhead'
      ],
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
            `~ ${((1 - (row["control"] / (row["experiment"]))) * 100).toFixed(1)}%`,
          row["stream"].toString(),
          (row["control"] === 'n/a' || row["stream"] === 'n/a') ?
            'n/a' :
            `~ ${((1 - (row["control"] / (row["stream"]))) * 100).toFixed(1)}%`,
          row["iterator"].toString(),
          (row["control"] === 'n/a' || row["iterator"] === 'n/a') ?
            'n/a' :
            `~ ${((1 - (row["control"] / (row["iterator"]))) * 100).toFixed(1)}%`
        ];
      }),
    },
    alignment: [Align.Left, Align.Center, Align.Center],
  });
}

export async function summarizeResults(folder: string) {
  const results: Record<string, Record<ExperimentType, number | 'n/a'>> = {};

  // gather up all the results files in the _reports directory:
  const filePaths = await glob(`**/_reports/${folder}/*.json`);
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
        experiment: 'n/a',
        stream: 'n/a',
        iterator: 'n/a'
      }
    }

    results[eventName][experimentType] = finished.duration;
  }

  // console.table(results);
  return results;
}

async function run() {
  const folders = ["throughput", "webapp"];
  for (const folder of folders) {
    console.log(`Summarizing reports for ${folder}...`);
    try {
      const results = await summarizeResults(folder);
      if (results) {
        console.table(results);
        if (args.write) {
          const table = makeMarkdownTable(results);
          await writeFile(`./_reports/${folder}/summary.md`, table);
        } else {
          console.warn('Not writing results to file. Use --write to write results to file.')
        }
      }
    } catch (err) {
      console.error(err, `Could not produce results for ${folder}`);
    }
  }
}

run().catch(console.error);
