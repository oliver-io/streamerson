function BULK_FACTOR (n: number) { return 1 };
function numberedControledTemplate(thousands: number) {
  const realFigure = thousands * 1000;
  return {
    [`write-${thousands}k-iterative`]: {
      count: realFigure,
      batchSize: 1,
      read: false
    },
    [`read-${thousands}k-iterative`]: {
      count: realFigure,
      batchSize: 1,
      read: true
    },
    [`write-${thousands}k-bulk`]: {
      count: realFigure,
      batchSize: Math.ceil(realFigure/BULK_FACTOR(realFigure)),
      read: false
    },
    [`read-${thousands}k-bulk`]: {
      count: realFigure,
      batchSize: Math.ceil(realFigure/BULK_FACTOR(realFigure)),
      read: true
    },
  }
}

export const definitions = {
  ...numberedControledTemplate(1),
  ...numberedControledTemplate(100)
};

export function getDefinition(name: keyof typeof definitions) {
  if (!definitions[name]) {
    throw new Error(`No definition for ${name}`);
  }

  return definitions[name];
}


type Definition = typeof definitions[keyof typeof definitions];

export function environmentForDefinition(name: string, definition: Definition) {
  return {
    ['STREAMERSON_BENCHMARK_PROJECT']: name,
    ['STREAMERSON_BENCHMARK_MESSAGE_COUNT']: definition.count.toString(),
    ['STREAMERSON_BENCHMARK_BATCH_SIZE']: definition.batchSize.toString(),
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
