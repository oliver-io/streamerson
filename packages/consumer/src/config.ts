export type ConsumerGroupOptions = {
    name: string;
    /**
     * Number of live cluster members the coordinator maintains. Defaults to 1.
     * Cluster-only: a lone `ConsumerGroupConfigurator` ignores it. Mutable at
     * runtime via `ConsumerGroupCluster.scale()` so a control plane can drive it.
     */
    count?: number;
    /** Per-message handler time budget, ms. `0` disables the budget. */
    processingTimeout?: number;
    /** Graceful-drain budget, ms, granted to in-flight handlers on drain/stop before force-terminate. */
    idleTimeout?: number;
    /** XREADGROUP BLOCK cadence, ms, for a member's read loop. Default 100. */
    blockTimeout?: number;
    /** Messages a member pulls per read; default 1 (one in-flight at a time). */
    prefetch?: number;
    /**
     * Opt-in retry (REQUEST_STREAM_RECEIPT.md §7). When set, delivery becomes
     * at-least-once (handlers MUST be idempotent): a thrown handler's entry stays
     * pending and is re-run on self-recovery / cross-machine reclaim up to
     * `maxAttempts` delivery attempts, then dead-lettered. Requires
     * `processingTimeout > 0` (the reclaim idle threshold). Absent ⇒ at-most-once
     * with no silent loss (failures dead-lettered immediately).
     */
    retry?: { maxAttempts: number };
}

function validateOptions(options: Required<Omit<ConsumerGroupOptions, 'retry'>> & Pick<ConsumerGroupOptions, 'retry'>) {
    if (!Number.isInteger(options.count) || options.count < 0) {
        throw new Error(`count must be a non-negative integer`);
    }
    if (options.processingTimeout < 0 || options.idleTimeout < 0) {
        throw new Error(`processingTimeout and idleTimeout must be >= 0`);
    }
    if (options.blockTimeout < 0) {
        throw new Error(`blockTimeout must be >= 0`);
    }
    if (!Number.isInteger(options.prefetch) || options.prefetch < 1) {
        throw new Error(`prefetch must be an integer >= 1`);
    }
    if (options.retry) {
        if (!Number.isInteger(options.retry.maxAttempts) || options.retry.maxAttempts < 1) {
            throw new Error(`retry.maxAttempts must be an integer >= 1`);
        }
        // Reclaim needs an idle threshold below which a slow (not dead) handler is
        // not stolen and re-run (CG-I7); 0 would steal in-flight work immediately.
        if (options.processingTimeout <= 0) {
            throw new Error(`retry requires processingTimeout > 0 (the reclaim idle threshold)`);
        }
    }
    return options;
}

export function createConsumerGroupConfig(options: ConsumerGroupOptions) {
    return validateOptions({
        name: options.name,
        count: options.count ?? 1,
        processingTimeout: options.processingTimeout ?? 0,
        idleTimeout: options.idleTimeout ?? 0,
        blockTimeout: options.blockTimeout ?? 100,
        prefetch: options.prefetch ?? 1,
        retry: options.retry,
    });
}

export type ConsumerGroupConfig = ReturnType<typeof createConsumerGroupConfig>;
