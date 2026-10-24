import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { contract, validateModel } from '../src/models/contract.js';

let app: FastifyInstance;
let authorization: string;
const password = 'test-only-long-password';
beforeAll(async () => {
  const auth = await AuthService.create('admin', password);
  app = await buildApp({ auth, polling: false });
  const token = await auth.login('admin', password);
  authorization = 'Bearer ' + token.accessToken;
});
afterAll(async () => { await app.close(); });

describe('HTTP contract and security', () => {
  const endpoints = [
    ['GET', '/api/dashboard'], ['GET', '/api/sessions/demo-unread'], ['POST', '/api/sessions/demo-unread/read'],
    ['GET', '/api/hosts'], ['POST', '/api/hosts'], ['PATCH', '/api/hosts/demo-dev'],
    ['DELETE', '/api/hosts/demo-dev'], ['POST', '/api/refresh'], ['POST', '/api/auth/logout'],
  ] as const;
  it.each(endpoints)('requires authentication: %s %s', async (method, url) => {
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(validateModel('Error', response.json())).toBe(true);
  });

  it('exposes only health and contract without login', async () => {
    const health = await app.inject('/api/health');
    expect(validateModel('Health', health.json())).toBe(true);
    const spec = await app.inject('/api/openapi.json');
    expect(spec.json().security).toEqual([{ bearerAuth: [] }]);
    const operations = Object.values(contract.paths).flatMap((path: unknown) => Object.values(path as object)).filter((operation: any) => operation.operationId);
    expect(operations).toHaveLength(14);
    expect(operations.map((operation: any) => operation.operationId)).toEqual(expect.arrayContaining(['requestSessionRefresh', 'getRefresh']));
  });

  it('does not claim the legacy backend implements the new continuous refresh protocol', async () => {
    for (const [method, url] of [['POST', '/api/sessions/demo-unread/refresh'], ['GET', '/api/refreshes/synthetic-job']] as const) {
      expect((await app.inject({ method, url, headers: { authorization } })).statusCode).toBe(404);
    }
  });

  it('validates actual dashboard, sessions and hosts against OpenAPI schemas', async () => {
    for (const [url, schema] of [['/api/dashboard', 'Dashboard'], ['/api/hosts', 'HostSettings'], ['/api/sessions/demo-unread', 'Session'], ['/api/sessions/demo-unknown', 'Session']]) {
      const response = await app.inject({ url, headers: { authorization } });
      expect(response.statusCode).toBe(200);
      expect(validateModel(schema, response.json())).toBe(true);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('logs in and logs out with revocation', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
    expect(login.statusCode).toBe(200);
    expect(validateModel('TokenResponse', login.json())).toBe(true);
    const headers = { authorization: 'Bearer ' + login.json().accessToken };
    expect((await app.inject({ url: '/api/dashboard', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).body).toBe('');
    expect((await app.inject({ url: '/api/dashboard', headers })).statusCode).toBe(401);
  });

  it('handles read conflicts, null turn ID and missing resources', async () => {
    const request = (id: string, turnId: string) => app.inject({ method: 'POST', url: '/api/sessions/' + id + '/read', headers: { authorization }, payload: { turnId } });
    expect((await request('demo-unread', 'old-turn')).json().code).toBe('TURN_CHANGED');
    const read = await request('demo-unread', 'demo-unread-turn-1');
    expect(read.json().status).toBe('read');
    expect(validateModel('Session', read.json())).toBe(true);
    expect((await request('demo-unknown', 'fake')).json().code).toBe('TURN_ID_UNAVAILABLE');
    expect((await app.inject({ url: '/api/sessions/missing', headers: { authorization } })).statusCode).toBe(404);
  });

  it('implements host CRUD with correct status codes and no-body responses', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/hosts', headers: { authorization }, payload: { target: 'api-test-host' } });
    expect(created.statusCode).toBe(201);
    expect(validateModel('Host', created.json())).toBe(true);
    expect(created.json().connection).toBe('unknown');
    const id = created.json().id;
    const patch = await app.inject({ method: 'PATCH', url: '/api/hosts/' + id, headers: { authorization }, payload: { enabled: false } });
    expect(patch.statusCode).toBe(204); expect(patch.body).toBe('');
    const removed = await app.inject({ method: 'DELETE', url: '/api/hosts/' + id, headers: { authorization } });
    expect(removed.statusCode).toBe(204); expect(removed.body).toBe('');
    expect((await app.inject({ method: 'DELETE', url: '/api/hosts/local', headers: { authorization } })).statusCode).toBe(409);
    const refresh = await app.inject({ method: 'POST', url: '/api/refresh', headers: { authorization } });
    expect(refresh.statusCode).toBe(204); expect(refresh.body).toBe('');
  });

  it('rejects type coercion, extra fields, malformed JSON and command injection', async () => {
    for (const payload of [{ enabled: 'false' }, { enabled: false, extra: true }]) {
      const result = await app.inject({ method: 'PATCH', url: '/api/hosts/demo-dev', headers: { authorization }, payload });
      expect(result.statusCode).toBe(400);
    }
    const malformed = await app.inject({ method: 'POST', url: '/api/hosts', headers: { authorization, 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400);
    expect(validateModel('Error', malformed.json())).toBe(true);
    const unsafe = await app.inject({ method: 'POST', url: '/api/hosts', headers: { authorization }, payload: { target: '-oProxyCommand=id' } });
    expect(unsafe.json().code).toBe('INVALID_TARGET');
  });

  it('rejects wrong content types and oversized bodies', async () => {
    const text = await app.inject({ method: 'POST', url: '/api/hosts', headers: { authorization, 'content-type': 'text/plain' }, payload: 'anything' });
    expect(text.statusCode).toBe(415);
    const large = await app.inject({ method: 'POST', url: '/api/hosts', headers: { authorization }, payload: { target: 'a'.repeat(17000) } });
    expect(large.statusCode).toBe(413);
    expect(validateModel('Error', large.json())).toBe(true);
  });

  it.each([{ host: 'evil.example' }, { host: 'localhost.evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])('rejects cross-site or rebinding requests: %j', async headers => {
    const response = await app.inject({ url: '/api/dashboard', headers: { authorization, ...headers } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FORBIDDEN_ORIGIN');
  });

  it('allows the Vite proxy origin without enabling cross-origin CORS', async () => {
    const response = await app.inject({ url: '/api/dashboard', headers: { authorization, origin: 'http://127.0.0.1:5173' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limits login attempts even for syntactically invalid credentials', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
  });
});
