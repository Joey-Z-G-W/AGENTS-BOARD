import { describe, expect, it, vi } from 'vitest';
import { createHttpService } from './http';

describe('HTTP service contract', () => {
  it('encodes session IDs and sends the turn ID with a read mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'read' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpService('/api/').markRead('host/session one', 'turn-two');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/host%2Fsession%20one/read', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{"turnId":"turn-two"}' }));
  });

  it('normalizes API errors including task conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '新任务已开始', code: 'CONFLICT' }), { status: 409 })));
    await expect(createHttpService().markRead('session', 'old')).rejects.toMatchObject({ code: 'CONFLICT', message: '新任务已开始' });
  });

  it('accepts empty mutation responses and reports network failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new TypeError('Offline'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createHttpService().refresh()).resolves.toBeUndefined();
    await expect(createHttpService().getDashboard()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('routes all host operations through the same service base', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const service = createHttpService('/custom-api');
    await service.getDashboard();
    await service.getHosts();
    await service.getSession('one');
    await service.addHost('staging');
    await service.setHostEnabled('user@host', false);
    await service.removeHost('user@host');
    expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['/custom-api/dashboard', 'GET'], ['/custom-api/hosts', 'GET'], ['/custom-api/sessions/one', 'GET'],
      ['/custom-api/hosts', 'POST'], ['/custom-api/hosts/user%40host', 'PATCH'], ['/custom-api/hosts/user%40host', 'DELETE'],
    ]);
  });
});
