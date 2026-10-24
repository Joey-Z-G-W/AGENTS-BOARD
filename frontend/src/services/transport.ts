import { ServiceError } from './types';
import { getAccessToken, setAccessToken } from './token';

export interface TransportOptions extends RequestInit {
  baseUrl?: string;
  timeoutMs?: number;
}

export async function apiFetch<Result>(path: string, options: TransportOptions = {}): Promise<Result> {
  const { baseUrl = import.meta.env.VITE_API_BASE_URL || '/api', timeoutMs = 15_000, signal, ...init } = options;
  if (signal?.aborted) throw new ServiceError('请求已取消。', 'CANCELLED');
  const token = getAccessToken();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init, headers, credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 && token && getAccessToken() === token) setAccessToken(null);
      const error: unknown = await response.json().catch(() => null);
      const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
      throw new ServiceError(typeof detail.message === 'string' ? detail.message : `请求失败（${response.status}）`, typeof detail.code === 'string' ? detail.code : String(response.status));
    }
    return response.status === 204 ? undefined as Result : await response.json() as Result;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (signal?.aborted) throw new ServiceError('请求已取消。', 'CANCELLED');
    throw new ServiceError(controller.signal.aborted ? '服务响应超时，请重试。' : '无法连接后端服务，请检查服务是否已启动。', 'NETWORK');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
