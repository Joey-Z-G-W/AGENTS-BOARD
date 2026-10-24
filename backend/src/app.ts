import Fastify, { type FastifyError } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AuthService } from './auth/service.js';
import { ApiError } from './models/errors.js';
import { contract } from './models/contract.js';
import { MemoryStore } from './store/memory.js';
import { authRoutes } from './routers/auth.js';
import { boardRoutes } from './routers/board.js';
import { hostRoutes } from './routers/hosts.js';

export interface AppOptions {
  auth: AuthService;
  store?: MemoryStore;
  allowedOrigins?: string[];
  polling?: boolean;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: false, routerOptions: { maxParamLength: 1024 } });
  const store = options.store ?? new MemoryStore();
  const origins = new Set(options.allowedOrigins ?? [
    'http://127.0.0.1:3001', 'http://localhost:3001',
    'http://127.0.0.1:5173', 'http://localhost:5173',
  ]);
  const publicRoutes = new Set(['GET /api/health', 'GET /api/openapi.json', 'POST /api/auth/login']);

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const failure = error instanceof ApiError ? error :
      new ApiError(error.statusCode && error.statusCode < 500 ? error.statusCode : 500,
        error.statusCode === 429 ? 'RATE_LIMITED' : error.statusCode && error.statusCode < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        error.statusCode === 429 ? '请求过多，请稍后重试。' : error.statusCode && error.statusCode < 500 ? '请求格式无效。' : '服务内部错误。');
    if (failure.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (failure.statusCode === 429) reply.header('Retry-After', '60');
    return reply.code(failure.statusCode).send({ code: failure.code, message: failure.message });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在。' }));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const authority = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(authority) ||
        (request.headers.origin !== undefined && !origins.has(request.headers.origin)) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'FORBIDDEN_ORIGIN', '只允许可信的本机请求。');
    }
    const route = request.method + ' ' + request.routeOptions.url;
    if (!publicRoutes.has(route)) options.auth.authenticate(request.headers.authorization);
  });

  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', errorResponseBuilder: () => ({ code: 'RATE_LIMITED', message: '请求过多，请稍后重试。' }) });
  app.addHook('preValidation', async request => {
    if (request.body !== undefined && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new ApiError(415, 'INVALID_REQUEST', '请求体必须为 application/json。');
    }
  });
  app.get('/api/health', async () => ({ status: 'ok', mode: 'in-memory-demo' }));
  app.get('/api/openapi.json', async () => contract);
  authRoutes(app, options.auth);
  boardRoutes(app, store);
  hostRoutes(app, store);
  const timer = options.polling === false ? undefined : setInterval(() => store.requestRefresh(), 15000);
  timer?.unref();
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); store.close(); });
  return app;
}
