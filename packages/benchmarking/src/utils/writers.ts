import { MessageType, shardDecorator, StreamingDataSource } from '@streamerson/core';
import { RedisClientType as Redis } from 'redis';

// const bigObject:Record<string, number> = {};
// for (let i = 0; i < 1000; i++) {
//   bigObject['key'+i] = i;
// }
const bigObject = {};

export function createFrameworkWriter(
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
  };
}

export function createBulkFrameworkWriter(
  datasource: StreamingDataSource,
  stream: string,
  MSG_COUNT: number,
  payload?: any,
  _batchSize: number = 1000
) {
  const batchSize = Math.min(MSG_COUNT, _batchSize);
  return async () => {
    let processed = 0;
    const writer = async (_: any, i: number) => {
      return datasource.writeToStream(
        stream,
        undefined,
        'test' as MessageType,
        'message' + i,
        JSON.stringify(payload ?? bigObject),
        'test'
      );
    };

    while (processed < MSG_COUNT) {
      const batch = Array(batchSize ?? 1).fill(0).map(writer);
      await Promise.all(batch);
      processed = processed + batch.length;
    }

    return {
      processed
    };
  };
}


export function createClientWriter(
  client: Redis,
  stream: string,
  MSG_COUNT: number,
  payload?: any
) {
  return async () => {
    for (let i = 0; i < MSG_COUNT; i++) {
      const str = 'message' + i;
      await client.xAdd(
        shardDecorator({ key: stream }), '*', {
          streamMessageId: str,
          messageType: 'test',
          incomingStream: '',
          messageHeaders: 'nil',
          messageProtocol: 'json',
          messageSourceId: 'test-source',
          payload: JSON.stringify(payload ?? bigObject)
        }
      );
    }
  }
}


  export function createBulkClientWriter(
    client: Redis,
    stream: string,
    MSG_COUNT: number,
    payload?: any,
    _batchSize = 1000
  ) {
    const batchSize = Math.min(MSG_COUNT, _batchSize);
    return async () => {
      let processed = 0;
      const writer = async (_: any, i: number) => {
        await client.xAdd(
          shardDecorator({ key: stream }), '*', {
            streamMessageId: 'message' + i,
            messageType: 'test',
            incomingStream: '',
            messageHeaders: 'nil',
            messageProtocol: 'json',
            messageSourceId: 'test-source',
            payload: JSON.stringify(payload ?? bigObject)
          }
        );
      };

      while (processed < MSG_COUNT) {
        const batch = Array(batchSize ?? 1).fill(0).map(writer);
        await Promise.all(batch);
        processed = processed + batch.length;
      }

      return {
        processed
      };
    };
  }
