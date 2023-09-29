type ConsumerGroupOptions = {
    name: string;
    min: number;
    max?: number;
    processingTimeout?: number;
    idleTimeout?: number;
}

function validateOptions(options: ConsumerGroupOptions) {
    // min must be good:
    if (options.min < 1) {
        throw new Error(`min must be greater than 0`);
    }

    // min must be less than max:
    if (options.max && options.min > options.max) {
        throw new Error(`min must be less than max`);
    }
}

export function createConsumerGroupConfig(options: ConsumerGroupOptions) {
    validateOptions(options);

    const {
        name,
        min,
        max = options.min,
        processingTimeout = 0,
        idleTimeout = 0
    } = options;

    return {
        name,
        min,
        max,
        processingTimeout,
        idleTimeout
    }
}

export type ConsumerGroupConfig = ReturnType<typeof createConsumerGroupConfig>;