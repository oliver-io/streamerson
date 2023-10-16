import {StreamingDataSource} from '@streamerson/core';
import {Redis} from 'ioredis';

export function createFrameworkReader(dataSource: StreamingDataSource, stream: string, options: {
  stopAt: number,
  startAt: number,
  failIfFewerRead: boolean,
  failIfMoreRead: boolean,
  batchSize?: number
}) {
  return async () => {
    let last = '0'
    let eventCount = 0;
    do {
      const { cursor, events } = await dataSource.blockingStreamBatchMap({
        stream,
        requestedBatchSize: options.batchSize ?? 1,
        last
      });
      eventCount += events.length;
      last = cursor as string;
    } while(last && eventCount < options.stopAt);

    if (
      (options.failIfFewerRead && (eventCount < options.stopAt)) ||
      (options.failIfMoreRead && (eventCount > options.stopAt))
    ) {
      throw new Error(`Expected ${options.stopAt} messages, but only read ${eventCount}`);
    }
  }
}

export function createClientReader(client: Redis, stream: string, config: {
  stopAt: number,
  startAt: number,
  failIfFewerRead: boolean,
  failIfMoreRead: boolean,
  batchSize?: number
}) {
  let cursor = config.startAt.toString();
  let messageCount = 0;
  const batchSize = config.batchSize ?? 1;
  let iterations = 0;
  return async () => {
    try {
      while (true) {
        iterations++;
        const result = (await client.call(
          'XREAD',
          'BLOCK',
          1000,
          "COUNT",
          batchSize,
          'STREAMS',
          stream,
          cursor,
        ) ?? []) as [streamId: string, batch: [messageId: string, properties: [k: string, v: string]]];

        const initialCount = messageCount;

        for (const page of result) {
          // const streamId = page[0];
          // const messageBatch = page[1];
          messageCount += page[1].length;
          cursor = page[1][page[1].length - 1][0];
        }

        // We didn't pull anything off the stream:
        if (messageCount === initialCount) {
          break;
        }

        if (messageCount >= config.stopAt) {
          break;
        }
      }
    } finally {
      if (
        (config.failIfFewerRead && (messageCount < config.stopAt)) ||
        (config.failIfMoreRead && (messageCount > config.stopAt))
      ) {
        throw new Error(`Expected ${config.stopAt} messages, but only read ${messageCount}`);
      }
    }

    return {
      iterations,
      messageCount
    }
  }
}
