import {StepEvent} from "./iterateTimedEvents";
import { type StreamersonLogger } from "@streamerson/core";
export function logTimingEvent(logger: StreamersonLogger, event: StepEvent, options?: {
  logProperties?: boolean
}) {
  if (options?.logProperties) {
    logger.info(event, `${event.step.toUpperCase()}`)
  } else {
    if ('duration' in event) {
      logger.info(`${(event.step.toUpperCase()+':').padEnd(8)} in ${event.duration} ms (${
        event.name
      })`);
    } else {
      logger.info(`${event.step.toUpperCase()} ${event.name}`);
    }
  }
}
