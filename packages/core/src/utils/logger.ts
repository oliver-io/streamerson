import pino from 'pino';
import {NullablePrimitive, StreamersonLogger} from "../types";

const DEFAULT_LOG_LEVEL = 'debug';


type CreateStreamersonLoggerOptions = {
  module?: string
} & Record<string, NullablePrimitive>;

function getLogLevel() {
  const level = (
    process.env['STREAMERSON_LOG_LEVEL'] || process.env['PINO_LOG_LEVEL'] || DEFAULT_LOG_LEVEL
  ).toLowerCase().trim();

  switch (level) {
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
      return level;
    default:
      console.warn(`Unknown log level (${level}), defaulting to default: "${DEFAULT_LOG_LEVEL}"`);
      return DEFAULT_LOG_LEVEL;
  }
}

export const alwaysLogger = pino({
  level: getLogLevel(),
  base: {
    module: 'streamerson'
  }
});

export function createStreamersonLogger(
  options: CreateStreamersonLoggerOptions = {},
  fromLogger: StreamersonLogger = alwaysLogger
): StreamersonLogger {
  if (options && Object.keys(options).length && fromLogger !== alwaysLogger && 'child' in fromLogger) {
    const childLogger = fromLogger.child(options);
    childLogger.level = getLogLevel();
    return childLogger;
  } else {
    // Likely to be `console` or some kind of override:
    return fromLogger;
  }
}
