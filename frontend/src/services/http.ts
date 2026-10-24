import { ServiceError, type BoardService, type Dashboard, type Host, type HostSettings, type Session } from './types';

export function createHttpService(baseUrl = '/api'): BoardService {
  const base = baseUrl.replace(/\/$/, '');
  async function request<Result>(path: string, method = 'GET', body?: unknown): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${base}${path}`, {
        method, signal: controller.signal, credentials: 'same-origin',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { message?: string; code?: string } | null;
        throw new ServiceError(error?.message ?? `请求失败（${response.status}）`, error?.code ?? String(response.status));
      }
      return response.status === 204 ? undefined as Result : await response.json() as Result;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(controller.signal.aborted ? '服务响应超时，请重试。' : '无法连接后端服务，请检查服务是否已启动。', 'NETWORK');
    } finally { clearTimeout(timeout); }
  }
  return {
    mode: 'http',
    getDashboard: () => request<Dashboard>('/dashboard'),
    getSession: (id) => request<Session>(`/sessions/${encodeURIComponent(id)}`),
    markRead: (id, turnId) => request<Session>(`/sessions/${encodeURIComponent(id)}/read`, 'POST', { turnId }),
    getHosts: () => request<HostSettings>('/hosts'),
    addHost: (target) => request<Host>('/hosts', 'POST', { target }),
    setHostEnabled: (id, enabled) => request<void>(`/hosts/${encodeURIComponent(id)}`, 'PATCH', { enabled }),
    removeHost: (id) => request<void>(`/hosts/${encodeURIComponent(id)}`, 'DELETE'),
    refresh: () => request<void>('/refresh', 'POST'),
  };
}
