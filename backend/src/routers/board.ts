import type { FastifyInstance } from 'fastify';
import { identifier, parseBody } from '../models/contract.js';
import type { MemoryStore } from '../store/memory.js';

export function boardRoutes(app: FastifyInstance, store: MemoryStore) {
  app.get('/api/dashboard', async () => store.getDashboard());
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async request => store.getSession(identifier(request.params.id)));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/read', async request => {
    const input = parseBody<{ turnId: string }>('MarkReadRequest', request.body);
    return store.markRead(identifier(request.params.id), input.turnId);
  });
  app.post('/api/refresh', async (_request, reply) => {
    store.requestRefresh();
    return reply.code(204).send();
  });
}
