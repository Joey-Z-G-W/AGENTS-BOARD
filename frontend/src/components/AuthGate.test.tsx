import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';
import { getAccessToken, setAccessToken } from '../services/token';
import { createHttpService } from '../services/http';

afterEach(() => setAccessToken(null));

it('logs in via the services layer, sends bearer tokens, then clears session on 401', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'demo-token', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 3600000).toISOString() })));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<AuthGate><div>Authenticated dashboard</div></AuthGate>);
  await userEvent.type(screen.getByLabelText('密码'), 'test-password');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('Authenticated dashboard')).toBeInTheDocument();
  expect(getAccessToken()).toBe('demo-token');
  fetchMock.mockResolvedValueOnce(new Response('{}'));
  await createHttpService().getDashboard();
  expect(fetchMock.mock.lastCall?.[0]).toBe('/api/dashboard');
  expect(new Headers(fetchMock.mock.lastCall?.[1].headers).get('Authorization')).toBe('Bearer demo-token');
  view.unmount();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: '过期' }), { status: 401 }));
  await expect(createHttpService().getHosts()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(getAccessToken()).toBeNull();
  expect(localStorage.length).toBe(0);
});

it('shows authentication errors without rendering private children', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: '用户名或密码错误。' }), { status: 401 })));
  render(<AuthGate><div>Private dashboard</div></AuthGate>);
  await userEvent.type(screen.getByLabelText('密码'), 'wrong');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
  expect(screen.queryByText('Private dashboard')).not.toBeInTheDocument();
});
