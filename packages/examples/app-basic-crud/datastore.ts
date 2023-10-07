interface Client {
    connect: ()=>Promise<any>,
    disconnect: ()=>Promise<any>,
    set: (key: string, value: string)=>Promise<any>,
    get: (key: string)=>Promise<any>,
    del: (key: string)=>Promise<any>,
    update: (key: string, value: string)=>Promise<any>,
    create: (key: string, value: string)=>Promise<any>,
}

export class Datastore<T extends Record<string, any>> {
    constructor(public client: Client) {}
    async connect() {
        return this.client.connect();
    }

    async disconnect() {
        return this.client.disconnect();
    }

    async set(id: string, value: T) {
        return await this.client.set(id, JSON.stringify(value));
    }

    async get(key: string) {
        return JSON.parse((await this.client.get(key)) ?? 'undefined') as T;
    }

    async del(key: string) {
        const deleted = await this.client.del(key);
        return !!deleted;
    }

    async update(key: string, value: T) {
        const existing = await this.get(key);
        if (!existing) {
            throw new Error(`No existing value found for key ${key}`);
        }
        return this.set(key, {
            ...existing,
            ...value
        });
    }

    async create(key: string, value: T) {
        const existing = await this.get(key);
        if (existing) {
            throw new Error(`Existing value found for key ${key}`);
        }
        return this.set(key, value);
    }
}