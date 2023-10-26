import {StreamingDataSource} from '@streamerson/core';
import {config} from '../../build/config';
import { Redis } from 'ioredis';
import pino from 'pino';
import {ExperimentType} from "./summarizeResults";

interface BaseContext {
  experimentType: ExperimentType
}

export interface ClientBenchmarkingContext extends BaseContext {
  datasource: Redis;
  logger: ReturnType<typeof pino>;
  connect: boolean;
}
export interface FrameworkBenchmarkingContext extends BaseContext {
  datasource: StreamingDataSource;
  logger: any;
  connect: boolean;
}

export type BenchmarkingContext = FrameworkBenchmarkingContext | ClientBenchmarkingContext;

export async function getClientContext(options?: { connect?: boolean }):Promise<ClientBenchmarkingContext> {
  const connect = options?.connect || true;
  const datasource = new Redis(config.redisPort ?? 6379, config.redisHost ?? 'localhost', {
    lazyConnect: false
  });
  const logger = pino();
  if (connect) {
    //await datasource.connect();
  }
  return {
    experimentType: 'control',
    datasource,
    logger,
    connect
  }
}

export async function getFrameworkContext(options?: { connect?: boolean, experimentType?: ExperimentType }): Promise<FrameworkBenchmarkingContext> {
  const connect = options?.connect ?? true;
  const datasource = new StreamingDataSource({
    host: config.redisHost,
    port: config.redisPort,
  });
  if (connect) {
    await datasource.connect();
  }
  const logger = datasource.logger;
  return {
    experimentType: options.experimentType ?? 'experiment',
    datasource,
    logger,
    connect
  }
}
