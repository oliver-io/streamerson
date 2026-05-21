import { Logger } from 'pino';

// A framework-agnostic no-op logger for tests (satisfies StreamersonLogger).
const noop = (..._args: any[]) => { /* swallow */ };

export const mockLogger = {
  info: noop,
  trace: noop,
  debug: noop,
  warn: noop,
  error: noop,
  child: () => mockLogger,
  level: 'debug',
};

export type { Logger };
