import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { parseBody } from '../models/contract.js';
import type { Credentials } from '../models/types.js';

export function authRoutes(app: FastifyInstance, auth: AuthService) {
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const input = parseBody<Credentials>('LoginRequest', request.body);
    return auth.login(input.username, input.password);
  });
  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.headers.authorization);
    return reply.code(204).send();
  });
}
