export type ConsumerGroupOptions = {
    name: string;
    min?: number;
    max?: number;
    processingTimeout?: number;
    idleTimeout?: number;
}

function validateOptions(options: Required<ConsumerGroupOptions>) {
    // min must be good:
    if (options.min < 1) {
        throw new Error(`min must be greater than 0`);
    }

    // min must be less than max:
    if (options.max && options.min > options.max) {
        throw new Error(`min must be less than max`);
    }

    return options;
}

export function createConsumerGroupConfig(options: ConsumerGroupOptions) {
    const {
        name,
        min = options.min ?? 1,
        max = options.max ?? 1,
        processingTimeout = 0,
        idleTimeout = 0
    } = options;

    return validateOptions({
        name,
        min,
        max,
        processingTimeout,
        idleTimeout
    })
}

export type ConsumerGroupConfig = ReturnType<typeof createConsumerGroupConfig>;
