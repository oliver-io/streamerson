import { MappedStreamEvent, NullablePrimitive, StateObjectTypes } from "../types"

export type StateTransformer = {
    incr: (target: string) => Promise<number | null>,
    decr: (target: string) => Promise<number | null>,
    get: (target: string) => Promise<string | number | null>,
    set: (target: string, value: string | number | null) => Promise<boolean>,
    // del: (target: string, value: string | number) => Promise<boolean>,
    setHash: (target: string, valueOrKey: string | {}, value?: {}) => Promise<boolean>,
    getHash: (target: string) => Promise<Record<string, string> | null>,
    // delHash: (target: string) => Promise<{} | null>,
    // delHashEntry: (target: string, valueOrKey: string | {}, value?: {}) => Promise<boolean>,
    transfer: (target: string, shardTarget: string, context?: { message: MappedStreamEvent, user: { id: string } }) => Promise<boolean>,
    broadcast: (targetStream: string, payload: { message: string } & Record<string, NullablePrimitive>, sourceId: string) => Promise<void>
}

// Why does the type inference pick up only the static callables of the Redis class?
// here we have to duplicate the interface for that reason:
export type StateTransformerMap<AState> = Record<keyof AState, StateTransformer> & {
    getClient: () => {
        get: (key: string) => Promise<string | null>,
        set: (key: string, value: string) => Promise<boolean>,
    }
};

export type ApplicationState<AState> = Record<keyof AState, StateConfiguration>;

export type StateConfiguration = {
    type: StateObjectTypes,
    owner: boolean,
    dataKey?: (propertyTarget: string, context?: { message?: MappedStreamEvent, user?: { id: string }}) => string,
    rent?: boolean,
    replicated?: boolean,
    local?: boolean,
    refresh?: boolean,
    ttl?: number
}