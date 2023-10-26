import {Topic} from '@streamerson/core';

export const topic = new Topic(process.env.STREAMERSON_GATEWAY_TOPIC || 'default-stream-topic');
