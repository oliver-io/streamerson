import { Logger } from 'pino';
import {mock } from 'node:test';
const getMock = ((obj: any)=>obj as ReturnType<typeof mock.fn>)

const mockLoggerBase = {
    info: mock.fn(),
    trace: mock.fn(),
    debug: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    child: mock.fn()
} as unknown as Logger;

export const mockLogger = {
    ...mockLoggerBase,
    mocks: {
        info: getMock(mockLoggerBase.info),
        trace: getMock(mockLoggerBase.trace),
        debug: getMock(mockLoggerBase.debug),
        warn: getMock(mockLoggerBase.warn),
        error: getMock(mockLoggerBase.error),
    }
};