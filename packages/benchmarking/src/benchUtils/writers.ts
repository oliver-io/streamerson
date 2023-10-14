import { StreamingDataSource } from '@streamerson/core';
import { Redis } from 'ioredis';

// const bigObject:Record<string, number> = {};
// for (let i = 0; i < 1000; i++) {
//   bigObject['key'+i] = i;
// }
const bigObject = {};

export function createDataSourceWriter(
  dataSource: StreamingDataSource,
  stream: string,
  MSG_COUNT: number,
  payload?: any
) {
  return async () => {
    for (let i = 0; i < MSG_COUNT; i++) {
      let str = 'message' + i;
      await dataSource.writeToStream(
        stream,
        undefined,
        'test' as any,
        str,
        JSON.stringify(payload ?? bigObject),
        'test'
      );
    }
  }
}


export function createClientWriter(
  client: Redis,
  stream: string,
  MSG_COUNT: number,
  payload?: any
) {
  return async () => {
    for (let i = 0; i < MSG_COUNT; i++) {
      let str = 'message' + i;
      await client.xadd(
        stream, // Stream
        '*', // ?
        str, // MessageId
        'test', // Message packing; TODO: Make this configurable
        '', // MessageDestination
        'nil', // Message headers
        'json', // Label for caution and pack type
        'test-source',
        'UnoccupiedField',
        JSON.stringify(payload ?? bigObject) // Payload
      );
    }
  }
}
