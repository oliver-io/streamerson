import { Logger } from 'pino';
import { StreamOptions } from '@streamerson/core';

export type PossiblyArray<T> = T | T[];

export type ServerOptions = {
  port: number;
  host: string;
  logger?: Logger;
  defaultMeta: StreamOptions;
};
