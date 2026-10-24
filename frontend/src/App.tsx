import { useMemo, useState } from 'react';
import { Activity, AlertCircle, ArrowUpRight, CheckCheck, ChevronRight, CircleHelp, FolderGit2, LayoutGrid, Monitor, RefreshCw, Search, Server, ShieldCheck, Sparkles, Terminal, Timer, X } from 'lucide-react';
import { boardService, type BoardService, type SessionStatus } from './services';
import { useBoard } from './hooks/useBoard';
import { countCurrent, relativeTime } from './lib/presentation';
import { HostSettings } from './components/HostSettings';
import { ProjectList } from './components/ProjectList';
import { SessionDetail } from './components/SessionDetail';

const filters: { value: 'all' | SessionStatus; label: string }[] = [
  { value: 'all', label: '全部会话' }, { value: 'waiting', label: '等待处理' }, { value: 'unread', label: '未读结果' },
  { value: 'running', label: '正在运行' }, { value: 'unknown', label: '状态未知' },
];

export default function App({ service = boardService }: { service?: BoardService }) {
  const { dashboard, settings, loadError, actionError, busy, reload, run } = useBoard(service);
  const [page, setPage] = useState<'dashboard' | 'hosts'>('dashboard');
  const [filter, setFilter] = useState<'all' | SessionStatus>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const projects = useMemo(() => (dashboard?.projects ?? []).map((project) => ({
    ...project, sessions: project.sessions.map((session) => loadError ? { ...session, freshness: 'stale' as const } : session),
  })), [dashboard, loadError]);
  const sessions = projects.flatMap((project) => project.sessions);
  const waiting = countCurrent(sessions, 'waiting');
  const unread = countCurrent(sessions, 'unread');
  const running = countCurrent(sessions, 'running');
  const cached = sessions.filter((session) => session.freshness === 'stale').length;
  const enabledHosts = settings.hosts.filter((host) => host.enabled);
  const onlineHosts = loadError ? 0 : enabledHosts.filter((host) => host.connection === 'online').length;
  const visible = projects.map((project) => ({ ...project, sessions: project.sessions.filter((session) => {
    const search = `${project.name} ${session.title} ${session.branch ?? ''} ${settings.hosts.find((host) => host.id === session.hostId)?.name ?? ''}`.toLowerCase();
    return (filter === 'all' || session.status === filter) && search.includes(query.trim().toLowerCase());
  }) })).filter((project) => project.sessions.length > 0 || (filter === 'all' && !query && projects.find((original) => original.id === project.id)?.sessions.length === 0));
  const switchPage = (next: 'dashboard' | 'hosts') => { setPage(next); setSelected(null); };

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); switchPage('dashboard'); }}><span className="brand-mark"><Activity size={22} /></span><span>agents<span className="brand-light">board</span><small>YOUR AGENTS, IN VIEW</small></span></a>
      <div className="workspace-label"><span className="workspace-avatar">J</span><span>Joey's workspace<small>个人工作空间</small></span><span className="workspace-dot" /></div>
      <div className="nav-label">工作空间</div><nav aria-label="主导航">
        <button className={`nav-link ${page === 'dashboard' ? 'active' : ''}`} onClick={() => switchPage('dashboard')}><LayoutGrid size={18} />工作看板{waiting + unread > 0 && <span className="nav-counter">{waiting + unread}</span>}</button>
        <button className={`nav-link ${page === 'hosts' ? 'active' : ''}`} onClick={() => switchPage('hosts')}><Server size={18} />主机设置<span className="nav-host-count">{settings.hosts.length || '—'}</span></button>
      </nav>
      <div className="sidebar-sources"><div className="nav-label">会话来源<span>3</span></div><div><span className="source-logo">⌘</span>Codex CLI</div><div><Terminal size={16} />Cursor CLI</div><div><span className="source-logo cursor-logo">↗</span>Cursor IDE</div></div>
      <div className="sidebar-bottom"><div className="local-card"><span className="local-indicator" /><span>{service.mode === 'mock' ? '模拟工作空间' : '本地工作空间'}<small>{service.mode === 'mock' ? '无需后端，即可体验' : '数据保留在本地'}</small></span><Monitor size={16} /></div><button className="help-button" onClick={() => setHelp((value) => !value)}><CircleHelp size={16} />看板如何工作<ArrowUpRight size={14} /></button><div className="sidebar-version">AGENTS BOARD <span>v0.1</span></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间<ChevronRight size={13} /><strong>{page === 'dashboard' ? '工作看板' : '主机设置'}</strong></div><div className="topbar-right"><span className="mode-badge"><span className="status-dot" />{service.mode === 'mock' ? 'MOCK 模式' : '本地服务'}</span><span className="user-avatar">J</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">{page === 'dashboard' ? 'AGENT ACTIVITY' : 'HOST MANAGEMENT'}</div><h1>{page === 'dashboard' ? '工作看板' : '主机设置'}<span className="heading-dot">.</span></h1><p>{page === 'dashboard' ? '掌握每一位 Agent 的进展，让注意力留在重要的事情上。' : '连接你的开发环境，在一个地方查看所有 Agent 的工作。'}</p></div><button className="secondary-button refresh-button" disabled={busy} onClick={() => void run(() => service.refresh())}><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? '刷新中…' : '立即刷新'}</button></div>
        {help && <div className="help-panel"><div><ShieldCheck size={20} /><strong>只读观察，按项目聚合</strong><button className="icon-button" aria-label="关闭说明" onClick={() => setHelp(false)}><X size={16} /></button></div><p>每 15 秒更新一次。打开已完成的会话即标记已读；已读任务完成超过 24 小时后隐藏。项目仅展示最近 7 天的 Agent 活动，状态未知和离线缓存会明确标注。</p><p>{service.mode === 'mock' ? '这里使用示例数据，不会读取真实 Agent 或发起 SSH 连接。设置和已读标记保存在当前浏览器。' : '只有可靠的原生事件用于判断任务状态，原生工具的已读识别取决于来源能力。'}</p></div>}
        {(loadError || actionError) && <div className="notice error" role="alert"><AlertCircle size={18} /><span>{loadError ?? actionError}{loadError && dashboard ? ' 当前显示缓存快照。' : ''}</span><button onClick={() => void reload()}>重新加载</button></div>}
        {!dashboard ? <div className="empty-state"><span className="empty-icon"><Activity size={27} /></span><h2>{loadError ? '暂时无法读取看板' : '正在整理 Agent 的工作…'}</h2><p>{loadError ? '检查连接后重试，已有数据不会被清除。' : '正在加载项目、会话与主机状态。'}</p>{loadError && <button className="secondary-button" onClick={() => void reload()}>重试连接</button>}</div> : page === 'hosts' ? <HostSettings settings={settings} service={service} busy={busy} run={run} /> : <>
          <section className="stats-grid" aria-label="工作概览">
            <button className={`stat-card running-stat ${filter === 'running' ? 'selected-stat' : ''}`} onClick={() => setFilter('running')}><span className="stat-top">正在运行<span className="stat-icon"><Activity size={18} /></span></span><span className="stat-value">{running.toString().padStart(2, '0')}<span>个会话</span></span><span className="stat-foot"><span className="live-dot" />Agent 正在推进工作</span></button>
            <button className={`stat-card ${filter === 'waiting' ? 'selected-stat' : ''}`} onClick={() => setFilter('waiting')}><span className="stat-top">等待处理<span className="stat-icon amber"><Timer size={18} /></span></span><span className="stat-value">{waiting.toString().padStart(2, '0')}<span>个会话</span></span><span className="stat-foot">需要你的回复或审批<ArrowUpRight size={13} /></span></button>
            <button className={`stat-card ${filter === 'unread' ? 'selected-stat' : ''}`} onClick={() => setFilter('unread')}><span className="stat-top">未读结果<span className="stat-icon blue"><CheckCheck size={18} /></span></span><span className="stat-value">{unread.toString().padStart(2, '0')}<span>个会话</span></span><span className="stat-foot">工作已完成，等你查看<ArrowUpRight size={13} /></span></button>
            <button className="stat-card" onClick={() => switchPage('hosts')}><span className="stat-top">监控主机<span className="stat-icon"><Server size={18} /></span></span><span className="stat-value">{onlineHosts.toString().padStart(2, '0')}<span>/ {enabledHosts.length} 台在线</span></span><span className="stat-foot">{enabledHosts.length - onlineHosts > 0 ? <><span className="offline-dot" />{enabledHosts.length - onlineHosts} 台离线或待验证</> : '所有主机连接正常'}</span></button>
          </section>
          <div className="section-heading"><div><h2>项目活动<span>{projects.length}</span></h2><p>最近 7 天 · 按 Agent 最新活动排序</p></div><span className="auto-refresh"><span className="status-dot" />每 15 秒自动更新</span></div>
          <div className="toolbar"><div className="filter-tabs" aria-label="按状态筛选">{filters.map((entry) => <button key={entry.value} aria-pressed={filter === entry.value} className={filter === entry.value ? 'active' : ''} onClick={() => setFilter(entry.value)}>{entry.label}{entry.value === 'all' && <span>{sessions.length}</span>}</button>)}</div><label className="search-box"><Search size={16} /><input aria-label="搜索项目或会话" placeholder="搜索项目、任务或分支…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label></div>
          {cached > 0 && <div className="cache-note"><AlertCircle size={14} />{cached} 个会话显示缓存状态，不计入当前运行、等待和未读数量。</div>}
          {visible.length ? <ProjectList projects={visible} hosts={settings.hosts} onOpen={setSelected} /> : <div className="empty-state"><span className="empty-icon"><FolderGit2 size={28} /></span><h2>{query || filter !== 'all' ? '没有匹配的会话' : '最近 7 天还没有项目活动'}</h2><p>{query || filter !== 'all' ? '试试其他关键词，或查看全部会话。' : '新发现的 Agent 会话会按项目出现在这里。'}</p>{(query || filter !== 'all') && <button className="secondary-button" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button>}</div>}
          <footer className="board-footer"><span><ShieldCheck size={14} />只读监控 · 不干扰 Agent 工作</span><span>最近更新 {relativeTime(dashboard.sampledAt)}<span className="separator">/</span>{service.mode === 'mock' ? '示例数据' : '本地数据'}</span></footer>
        </>}
        <div className="bottom-signature"><Sparkles size={13} /><span>Less checking. More building.</span></div>
      </main>
    </div>
    {selected && <SessionDetail key={selected} id={selected} latestTurnId={sessions.find((session) => session.id === selected)?.turnId} service={service} hosts={settings.hosts} onClose={() => setSelected(null)} onRead={reload} stale={!!loadError} />}
  </div>;
}
