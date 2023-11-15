import {StreamingDataSource, StreamersonLogger } from '@streamerson/core';
import {config} from '../config';
import { Redis } from 'ioredis';
import pino from 'pino';
import {ExperimentType} from "../../tools/summarizeResults";

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
  const connect = options?.connect ?? true;
  const logger = pino();
  if (connect) {
    const datasource = new Redis(config.redisPort ?? 6379, config.redisHost ?? 'localhost', {
      lazyConnect: true
    });
    if (connect) {
      await datasource.connect();
    }
    return {
      experimentType: 'control',
      datasource,
      logger,
      connect
    }
  } else {
    return {
      experimentType: 'control',
      datasource: null as any,
      logger,
      connect: false
    }
  }
}

export async function getFrameworkContext(options?: { connect?: boolean, experimentType?: ExperimentType }): Promise<FrameworkBenchmarkingContext> {
  const connect = options?.connect ?? true;
  const datasource = new StreamingDataSource({
    controllable: true,
    logger: pino({
      level: 'warn'
    }) as unknown as StreamersonLogger,
    host: config.redisHost,
    port: config.redisPort,
  });
  if (connect) {
    await datasource.connect();
  }
  const logger = pino();
  return {
    experimentType: options?.experimentType ?? 'experiment',
    datasource,
    logger,
    connect
  }
}
