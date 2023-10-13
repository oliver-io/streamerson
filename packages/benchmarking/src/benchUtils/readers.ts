import { StreamingDataSource } from '@streamerson/core';

export function createBatchDataSourceReader(dataSource: StreamingDataSource, stream: string, MSG_COUNT: number) {
  return async () => {
    await dataSource.readAsSingle(stream, '0', 1000);
  }
}
