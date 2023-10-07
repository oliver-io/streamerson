import {ids} from "@streamerson/core";
import {Datastore} from "./datastore";

type EventWithIdPayload = { payload: { id: string }};

export function createCrudService(datastore: Datastore<any>) {
    return {
        create: async function create(e: { payload: Record<string, any> }) {
            const newObject = {
                ...e.payload,
                id: ids.guuid()
            };
            await datastore.create(newObject.id, newObject);
            return newObject;
        },
        read: async (e: EventWithIdPayload) => {
            return {
                data: await datastore.get(e.payload.id)
            }
        },
        update: async (e: EventWithIdPayload) => {
            return await datastore.update(e.payload.id, e.payload)
        },
        delete: async (e: EventWithIdPayload) => {
            return {
                deleted: await datastore.del(e.payload.id)
            }
        }
    }
}