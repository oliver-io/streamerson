import { ExtendedError } from './errors';
import {StreamersonLogger} from "@streamerson/core";
export function withExtendedErrors(err: Error | ExtendedError, logger: StreamersonLogger = console): void {
  let handledError = err;
  let shouldLog = true;
  if (handledError instanceof ExtendedError && handledError.handled && handledError.exposed) {
    shouldLog = !handledError.logged;
    logger[handledError.level](err, err.message);
    handledError.logged = true;
    if (!handledError.handled) {
      throw handledError;
    }
  } else {
    let wrappedError = new ExtendedError(err);
    logger[wrappedError.level](err, err.message);
    wrappedError.logged = true;
    throw wrappedError;
  }
}
