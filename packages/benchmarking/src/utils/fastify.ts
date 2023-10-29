import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
export async function createServer(port: number, host: string, options: {
  endpoints: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler?: (request: FastifyRequest, reply: FastifyReply) => Promise<any>;
  }>
}) {
  const app = Fastify({
    logger: false
  });

  for (const endpoint of options.endpoints) {
    if (endpoint.method === 'GET') {
      app.get(endpoint.path, endpoint.handler ?? (async () => {
        return { data: "Hello World!" };
      }));
    } else if (endpoint.method === 'POST') {
      app.post(endpoint.path, endpoint.handler ?? (async (request) => {
        return { data: "Hello World!" };
      }));
    }
  }

  await app.listen(port, host);
  return app;
}
