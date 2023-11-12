import { Topic, StreamingDataSource } from '@streamerson/core';

const producer = new StreamingDataSource();
const topic = new Topic('my-stream-topic');

await producer.connect();

await producer;
