import {StreamersonLogger, StreamingDataSource} from '@streamerson/core';
import {config} from '../../build/config';
import { Redis } from 'ioredis';
import pino from 'pino';

interface BaseContext {
  experimentType: 'control' | 'experiment'
}

export interface ClientBenchmarkingContext extends BaseContext {
  datasource: Redis;
  logger: ReturnType<typeof pino>;
}
export interface FrameworkBenchmarkingContext extends BaseContext {
  datasource: StreamingDataSource;
  logger: StreamersonLogger;
}

export type BenchmarkingContext = FrameworkBenchmarkingContext | ClientBenchmarkingContext;

export async function getClientContext():Promise<ClientBenchmarkingContext> {
  const datasource = new Redis(config.redisPort ?? 6379, config.redisHost ?? 'localhost', {
    lazyConnect: true
  });
  const logger = pino();
  await datasource.connect();
  return {
    experimentType: 'control',
    datasource,
    logger
  }
}

export async function getFrameworkContext(): Promise<FrameworkBenchmarkingContext> {
  const datasource = new StreamingDataSource({
    host: config.redisHost,
    port: config.redisPort,
  });
  await datasource.connect();
  const logger = datasource.logger;
  return {
    experimentType: 'experiment',
    datasource,
    logger
  }
}
