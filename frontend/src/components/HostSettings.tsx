import { useState, type FormEvent } from 'react';
import { Check, CircleHelp, Laptop, Plus, Server, ShieldCheck, Trash2, WifiOff } from 'lucide-react';
import type { BoardService, HostSettings as HostSettingsData } from '../services';
import { dateTime } from '../lib/presentation';

export function HostSettings({ settings, service, busy, run }: {
  settings: HostSettingsData; service: BoardService; busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [target, setTarget] = useState('');
  const [feedback, setFeedback] = useState('');
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback('');
    if (await run(() => service.addHost(target))) { setFeedback('主机已加入监控列表。'); setTarget(''); }
  };
  return <div className="settings-layout">
    <section className="settings-panel"><div className="panel-title"><h2>监控主机</h2><span>{settings.hosts.length} 台主机</span></div>
      <p className="muted">自动监控本机，通过现有 SSH 配置读取远端会话。</p>
      <div className="host-list">{settings.hosts.map((host) => <article className="host-card" key={host.id}>
        <div className={`host-icon ${host.connection === 'offline' ? 'offline' : ''}`}>{host.local ? <Laptop size={22} /> : <Server size={22} />}</div>
        <div className="host-information"><h3>{host.name}{host.local && <span className="neutral-badge">自动监控</span>}</h3><p className="mono">{host.address}</p>
          <span className="host-last">最近成功采集：{dateTime(host.lastSuccessAt)}</span>
          {host.error && <p className="host-error"><WifiOff size={13} />{host.error}</p>}
        </div>
        <span className={`connection-label ${!host.enabled ? 'disabled' : host.connection}`}><span className="status-dot" />{!host.enabled ? '已暂停' : host.connection === 'online' ? '在线' : '离线'}</span>
        {!host.local && <div className="host-actions"><button className="small-button" disabled={busy} onClick={() => void run(() => service.setHostEnabled(host.id, !host.enabled))} aria-label={`${host.enabled ? '暂停' : '启用'} ${host.name}`}>{host.enabled ? '暂停' : '启用'}</button><button className="icon-button danger" disabled={busy} aria-label={`移除 ${host.name}`} onClick={() => void run(() => service.removeHost(host.id))}><Trash2 size={16} /></button></div>}
      </article>)}</div>
    </section>
    <div className="settings-side"><section className="settings-panel"><div className="panel-title"><h2>添加 SSH 主机</h2><Plus size={18} /></div>
      <form onSubmit={(event) => void add(event)}><label htmlFor="host-target">SSH 别名或地址</label><input id="host-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如 staging 或 joey@host" required maxLength={128} autoComplete="off" /><button className="primary-button full-width" disabled={busy || !target.trim()}><Plus size={16} />添加到监控</button></form>
      {feedback && <p className="success-message" role="status"><Check size={15} />{feedback}</p>}
      <div className="candidate-list"><span className="eyebrow">{service.mode === 'mock' ? '示例 SSH 配置' : '来自 ~/.ssh/config'}</span>{settings.candidates.map((candidate) => {
        const exists = settings.hosts.some((host) => host.name === candidate.alias || host.address === candidate.address);
        return <button key={candidate.alias} disabled={exists || busy} onClick={() => setTarget(candidate.alias)}><Server size={14} /><span>{candidate.alias}</span>{exists ? <Check size={14} /> : <Plus size={14} />}</button>;
      })}{settings.candidates.length === 0 && <p className="muted">没有可导入的 SSH 别名，可以手动添加。</p>}</div>
    </section><aside className="settings-note"><ShieldCheck size={22} /><h3>只读，保持原来的工作方式</h3><p>看板不发送指令或审批命令，也不保存 SSH 密码和私钥。</p><div><CircleHelp size={15} /><span>{service.mode === 'mock' ? '当前主机与连接结果均为模拟数据，没有发起真实 SSH 连接。' : '新增主机需已在系统中配置 SSH 密钥与可信主机记录。'}</span></div></aside></div>
  </div>;
}
