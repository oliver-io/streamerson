import {ids, NullablePrimitive} from '@streamerson/core';
import {StreamConsumer } from '@streamerson/consumer';
import {Events, streamTopic} from "./api";
import {Datastore} from "./datastore";
import {createCrudService} from "./crud";

const datastore = new Datastore({
    async connect() { /* no-op example */ },
    async disconnect() { /* no-op example */ },
    async del(id) { /* no-op example */ },
    async get(id) { /* no-op example */ },
    async set(id, val) { /* no-op example */ },
    async update(id, val) { /* no-op example */ },
    async create(id, val) { /* no-op example */ },
});

const consumer = new StreamConsumer({
    topic: streamTopic
});

type PayloadWithId = Record<string, NullablePrimitive> & { id: string };
type PayloadWithData = Record<string, any> & { data: any };

const service = createCrudService(datastore);

consumer.registerStreamEvent(Events.CREATE, service.create);
consumer.registerStreamEvent<PayloadWithId, PayloadWithData>(Events.READ, service.read);
consumer.registerStreamEvent<PayloadWithId>(Events.UPDATE, service.update);
consumer.registerStreamEvent<PayloadWithId>(Events.DELETE, service.delete);

await datastore.connect();
await consumer.connectAndListen();