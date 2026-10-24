import { afterEach, describe, expect, it, vi } from 'vitest';
import contract from '../../../_docs/api/openapi.json';
import { getRefresh, requestSessionRefresh } from './generated/board';
import { createHttpService } from './http';
import { apiFetch } from './transport';
import { getAccessToken, setAccessToken } from './token';

afterEach(() => setAccessToken(null));

describe('generated client transport', () => {
  it('preserves nullable values and enum strings from the contract examples', async () => {
    const session = contract.components.schemas.Session.examples[1];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(session))));
    await expect(createHttpService().getSession(session.id)).resolves.toEqual(session);
  });

  it('decodes accepted refresh jobs and encodes opaque IDs exactly once', async () => {
    const job = { id: 'job/one', status: 'queued', collectionVersion: null, error: null };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(job), { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestSessionRefresh('session/% ?')).resolves.toEqual(job);
    await expect(getRefresh(job.id)).resolves.toEqual(job);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/sessions/session%2F%25%20%3F/refresh', '/api/refreshes/job%2Fone']);
  });

  it('does not clear a new token when an older request returns 401', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; })));
    setAccessToken('old-token');
    const pending = createHttpService().getDashboard();
    setAccessToken('new-token');
    finish(new Response('{"code":"UNAUTHORIZED"}', { status: 401 }));
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getAccessToken()).toBe('new-token');
  });

  it('clears only the current token and handles non-JSON errors safely', async () => {
    setAccessToken('current-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 401 })));
    await expect(createHttpService().getHosts()).rejects.toMatchObject({ code: '401' });
    expect(getAccessToken()).toBeNull();
  });

  it('propagates caller cancellation without misreporting a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const controller = new AbortController();
    const pending = createHttpService().getSession('one', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not call fetch for an already cancelled request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(createHttpService().getDashboard(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a timed-out request and removes its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const result = expect(apiFetch('/dashboard', { timeoutMs: 25 })).rejects.toMatchObject({ code: 'NETWORK', message: '服务响应超时，请重试。' });
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles malformed success JSON as a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid json')));
    await expect(createHttpService().getDashboard()).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
