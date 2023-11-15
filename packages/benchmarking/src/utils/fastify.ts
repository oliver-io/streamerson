import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
export async function createServer(port: number, host: string, options: {
  endpoints: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler?: (request: FastifyRequest, reply: FastifyReply) => Promise<any>;
    timeout?: number
  }>
}) {
  const app = Fastify({
    logger: {
      level: 'warn'
    }
  });

  for (const endpoint of options.endpoints) {
    app.route({
      method: endpoint.method,
      url: endpoint.path,
      handler: endpoint.handler ?? (async (request, reply) => {
        return { data: "Hello World!" };
      })
    });
  }

  await app.listen(port, host);
  return app;
}
