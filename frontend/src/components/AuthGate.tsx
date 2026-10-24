import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { login, logout } from '../services/auth';
import { getAccessToken, setAccessToken, subscribeToken } from '../services/token';

export function AuthGate({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(subscribeToken, getAccessToken);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token || expiresAt === null) return;
    const timer = setTimeout(() => setAccessToken(null), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [token, expiresAt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await login(username, password);
      setExpiresAt(Date.parse(result.expiresAt));
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败'); }
    finally { setPassword(''); setBusy(false); }
  };

  if (token) return <>
    <div className="auth-bar"><span>已认证 · 本地内存后端（数据来源见看板提示）</span><button className="small-button" onClick={() => {
      void logout().catch(() => setError('已清除本机令牌；服务端注销未确认，令牌将在过期后失效。'));
    }}>退出登录</button></div>
    {children}
  </>;

  return <main className="login-layout"><section className="settings-panel login-panel">
    <h1>登录 Agents Board</h1>
    <p className="muted">使用启动后端时配置的账号密码。令牌只保留在页面内存，刷新页面后需重新登录。</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    <form onSubmit={event => void submit(event)}>
      <label htmlFor="login-user">用户名</label>
      <input id="login-user" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={64} />
      <label htmlFor="login-password">密码</label>
      <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} />
      <button className="primary-button full-width" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
    </form>
  </section></main>;
}
