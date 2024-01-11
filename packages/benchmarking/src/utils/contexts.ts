import {StreamingDataSource, StreamersonLogger } from '@streamerson/core';
import {config} from '../config';
import { RedisClientType as Redis, createClient } from 'redis';
import pino, { Logger } from 'pino';

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
  const logger = pino() as Logger<any>;
  if (connect) {
    const datasource = createClient({
      // port: config.redisPort ?? 6379,
      url: config.redisHost ?? 'localhost'
    });

    if (connect) {
      await datasource.connect();
    }
    return {
      experimentType: 'control',
      datasource: datasource as Redis,
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
      level: 'debug'
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
