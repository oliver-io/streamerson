import { StreamingDataSource } from '@streamerson/core';
import { Redis } from 'ioredis';

export function createBatchDataSourceReader(dataSource: StreamingDataSource, stream: string, MSG_COUNT: number) {
  return async () => {
    await dataSource.readAsSingle(stream, '0', 1000);
  }
}

export function createBatchClientReader(client: Redis, stream: string, MSG_COUNT: number) {
  return async () => {
    return (await client.call(
      'XREAD',
      'BLOCK',
      1000,
      // "COUNT", 10,
      'STREAMS',
      stream,
      '',
    ) ?? []) as [id:string, batch: Array<[k: string, v: string]>];
  }
}
