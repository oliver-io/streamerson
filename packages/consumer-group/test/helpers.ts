import {MessageType} from '@streamerson/core';
import {mock} from 'node:test';
import {ConsumerGroupMember} from "../src/member";

export function makeTestMessage(
    options: {
        type: string
        stream: string,
        id: string,
        payload: Record<string, any>,
        source?: string
    }
): [inStream: string, outStream: undefined, type: MessageType, id: string, payload: string, source: string] {
    return [
        options.stream,
        undefined,
        options.type as MessageType,
        options.id,
        JSON.stringify(options.payload),
        options.source ?? 'from-test'
    ]
}

export async function spyForConsumerGroupMessage(
    groupMember: ConsumerGroupMember<any>,
    message: ReturnType<typeof makeTestMessage>
) {
    let free:(value: any)=>void;
    let $freed = new Promise((resolve, reject)=> {
        free = resolve;
        setTimeout(reject, 5000);
    })

    const hasBeenCalled = mock.fn((data: any)=>{
        return (free(null), {
            ok: true
        });
    });

    const id = Math.random().toString();

    groupMember.registerStreamEvent(id, hasBeenCalled);
    await groupMember._channel.writeToStream(...message);
    return hasBeenCalled;
}