import { Logger } from 'pino';
import {mock } from 'node:test';
const getMock = ((obj: any)=>obj as ReturnType<typeof mock.fn>)

export const mockLogger = {
    info: mock.fn(),
    trace: mock.fn(),
    debug: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    child: mock.fn()
};

export type { Logger }