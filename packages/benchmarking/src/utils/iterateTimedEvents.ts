import {buildReport} from "./report";

type BaseEventSteps = 'begin' | 'finalized';

export type StepEvent = {
  name: string;
} & ({
  step: 'start' | BaseEventSteps
} | {
  step: 'finished' | BaseEventSteps
  duration: number
});

export type StageInfo = Array<{
  name: string;
  fn: () => Promise<void>;
}>;

export async function *iterateTimedEvents(stages: StageInfo): AsyncGenerator<StepEvent> {
  const totalTiming = new Date();
  yield {
    name: 'timing',
    step: 'begin',
  };
  for (const stage of stages) {
    yield {
      name: stage.name,
      step: 'start'
    } ;
    const start = Date.now();
    await stage.fn();
    const end = Date.now();
    yield {
      name: stage.name,
      step: 'finished',
      duration: end - start,
    };
  }
  yield {
    name: 'timing',
    step: 'finalized',
    duration: Date.now() - totalTiming.getTime(),
  };
}
