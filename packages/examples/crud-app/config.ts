import {Topic} from "@streamerson/core";

export const baseTopic = new Topic({
    namespace: 'crud-app'
});

export const streamTopic = baseTopic.subtopic('examples');

export enum Events {
    HELLO_EVENT = 'hello'
}