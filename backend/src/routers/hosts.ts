import type { FastifyInstance } from 'fastify';
import { identifier, parseBody } from '../models/contract.js';
import type { MemoryStore } from '../store/memory.js';

export function hostRoutes(app: FastifyInstance, store: MemoryStore) {
  app.get('/api/hosts', async () => store.getHosts());
  app.post('/api/hosts', async (request, reply) => {
    const input = parseBody<{ target: string }>('AddHostRequest', request.body);
    return reply.code(201).send(store.addHost(input.target));
  });
  app.patch<{ Params: { id: string } }>('/api/hosts/:id', async (request, reply) => {
    const input = parseBody<{ enabled: boolean }>('UpdateHostRequest', request.body);
    store.setHostEnabled(identifier(request.params.id), input.enabled);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (request, reply) => {
    store.removeHost(identifier(request.params.id));
    return reply.code(204).send();
  });
}
