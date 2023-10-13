import { StreamingDataSource } from '@streamerson/core';

// const bigObject:Record<string, number> = {};
// for (let i = 0; i < 1000; i++) {
//   bigObject['key'+i] = i;
// }
const bigObject = {};

export function createDataSourceWriter(
  dataSource: StreamingDataSource,
  stream: string,
  MSG_COUNT: number
) {
  return async () => {
    for (let i = 0; i < MSG_COUNT; i++) {
      let str = 'message' + i;
      await dataSource.writeToStream(
        stream,
        undefined,
        'test' as any,
        str,
        JSON.stringify(bigObject),
        'test'
      );
    }
  }
}
