import {definitions} from "./definitions";

type Definition = typeof definitions[keyof typeof definitions];

export function environmentForDefinition(name: string, definition: Definition) {
  return {
    ['STREAMERSON_BENCHMARK_PROJECT']: name,
    ['STREAMERSON_BENCHMARK_MESSAGE_COUNT']: definition.count,
    ['STREAMERSON_BENCHMARK_BATCH_SIZE']: definition.batchSize
  }
}


export function getBenchmarkConfig() {
  const config = {
    benchmarkName: process.env['STREAMERSON_BENCHMARK_PROJECT'],
    messageCount: parseInt(process.env['STREAMERSON_BENCHMARK_MESSAGE_COUNT']),
    batchSize: parseInt(process.env['STREAMERSON_BENCHMARK_BATCH_SIZE']),
  };

  if (!config.benchmarkName) {
    throw new Error('No benchmark name specified');
  }

  if (!config.messageCount) {
    throw new Error('No message count specified');
  }

  if (!config.batchSize) {
    throw new Error('No batchSize specified');
  }

  return config;
}
