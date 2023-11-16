type ErrorLogLevel = 'warn' | 'error';

const defaultOptions = {
  code: 500,
  handled: false,
  exposed: false,
  type: 'INTERNAL_ERROR',
  level: 'error' as ErrorLogLevel
};

type ExtendedErrorOptions = {
  code?: number,
  type?: string,
  handled?: boolean,
  exposed?: boolean,
  level?: ErrorLogLevel
};

export class ExtendedError extends Error {
  public code: number;
  public handled: boolean;
  public exposed: boolean;
  public type: string;
  public level: ErrorLogLevel;
  public logged: boolean = false;

  constructor(message: any, public options: ExtendedErrorOptions = defaultOptions) {
    super(typeof message === 'string' ?
      (message as string) :
      (('message' in message as any)
        ? message.message as string :
        'Unknown error')
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ExtendedError);
    }

    this.name = this.constructor.name;
    this.code = options?.code ?? defaultOptions.code;
    this.handled = options?.handled ?? defaultOptions.handled;
    this.exposed = options?.exposed ?? defaultOptions.exposed;
    this.type = options?.type ?? defaultOptions.type;
    this.level = options?.level ?? defaultOptions.level;
    this.logged = false;

    Object.defineProperty(this, 'name', {enumerable: true});
    Object.defineProperty(this, 'code', {enumerable: true});
    Object.defineProperty(this, 'type', {enumerable: true});
    Object.defineProperty(this, 'handled', {enumerable: true});
    Object.defineProperty(this, 'exposed', {enumerable: true});
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      type: this.type,
      stack: this.stack
    };
  }
}

type UserErrorTypes = 'MALFORMED_REQUEST' | 'BAD_PARAMETERS' | 'REJECTED';
type UserErrorOptionSubset<T extends string> = ExtendedErrorOptions & {
  type: UserErrorTypes | T,
  code?: 400 | 401 | 403,
  handled: true,
  exposed: true,
  level: 'warn'
}

export class ErrorForEndUser<T extends string> extends ExtendedError {
  constructor(message: string, public override options: UserErrorOptionSubset<T>) {
    super(message, options);
  }
}


// Errors that cannot be handled by retry ops and might indicate an error in the actual code / data:
type DeveloperErrorTypes = 'MALFORMED_CONFIGURATION' | 'BAD_INPUT' | 'CONNECTION_ERROR' | 'DATA_ERROR';
type DeveloperErrorOptionSubset<T extends string = DeveloperErrorTypes> = ExtendedErrorOptions & {
  type: DeveloperErrorTypes | T,
  code?: 500,
  handled: false,
  exposed: false,
  level: 'error'
}

export class ErrorForDeveloper<T extends string> extends ExtendedError {
  constructor(message: string, public override options: DeveloperErrorOptionSubset<T>) {
    super(message, options);
  }
}

// Errors that cannot be handled by retry ops and might indicate an error in the actual code / data:
type HandledErrorTypes = 'RETRY_CONNECTION' | 'TIMEOUT' | 'BACKOFF' | 'MISSING_DATA';

type HandledErrorOptionSubset<T extends string> = ExtendedErrorOptions & {
  type: HandledErrorTypes | T,
  code: 5000,
  handled: true,
  exposed: false,
  level: 'error' | 'warn'
}

// Errors that can be retried / remediated by an error handler:
export class ErrorForHandler extends ExtendedError {
  constructor(message: string, public override options: HandledErrorOptionSubset<string>) {
    super(message, options);
  }
}
