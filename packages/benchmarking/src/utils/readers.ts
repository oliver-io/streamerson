import { StreamingDataSource } from '@streamerson/core';
import { RedisClientType as Redis } from 'redis';

export function createFrameworkReader(dataSource: StreamingDataSource, stream: string, options: {
  stopAt: number,
  startAt: number,
  failIfFewerRead: boolean,
  failIfMoreRead: boolean,
  batchSize?: number
}) {
  return async () => {
    let last = '0';
    let eventCount = 0;
    do {
      const { cursor, events } = await dataSource.blockingStreamBatchMap({
        stream,
        requestedBatchSize: options.batchSize ?? 1,
        last
      });
      eventCount += events.length;
      last = cursor as string;
    } while (last && eventCount < options.stopAt);

    if (
      (options.failIfFewerRead && (eventCount < options.stopAt)) ||
      (options.failIfMoreRead && (eventCount > options.stopAt))
    ) {
      throw new Error(`Expected ${options.stopAt} messages, but only read ${eventCount}`);
    }
  };
}


export function createFrameworkStreamer(dataSource: StreamingDataSource, stream: string, options: {
  stopAt: number,
  startAt: number,
  failIfFewerRead: boolean,
  failIfMoreRead: boolean,
  batchSize?: number
}) {
  let { batchSize = 1, stopAt, startAt = 0 } = options;
  return async () => {
    const readStream = dataSource.getReadStream({
      stream,
      last: startAt.toString(),
      requestedBatchSize: batchSize,
      blockingTimeout: 1000
    });

    let eventCount = 0;
    let timeout: NodeJS.Timeout | null = null;

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        readStream.on('data', (e) => {
          dataSource.logger.info(e);
          eventCount++;
          if (eventCount >= stopAt) {
            resolve();
          }
        });
      }),
      new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Expected ${stopAt} messages, but only read ${eventCount}`));
        }, 10000);
      })
    ]);

    if (timeout) {
      clearTimeout(timeout);
    }
  };
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
        const result = await this.client.xRead({
          key: stream,
          id: cursor
        }, {
          BLOCK: 1000,
          COUNT: batchSize
        });

        const initialCount = messageCount;

        for (const page of result.messages) {
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
    };
  };
}
