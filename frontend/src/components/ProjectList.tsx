import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Monitor, Server, Terminal, WifiOff } from 'lucide-react';
import type { Host, Project, Session } from '../services';
import { countCurrent, relativeTime, sourceLabels } from '../lib/presentation';
import { StatusBadge } from './StatusBadge';

export function ProjectList({ projects, hosts, onOpen }: { projects: Project[]; hosts: Host[]; onOpen: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <div className="project-list">{projects.map((project) => {
    const isCollapsed = collapsed.has(project.id);
    const unknown = project.sessions.filter((session) => session.status === 'unknown').length;
    const stale = project.sessions.filter((session) => session.freshness === 'stale').length;
    return <section className="project-panel" key={project.id} aria-label={project.name}>
      <button className="project-heading" aria-expanded={!isCollapsed} aria-controls={`project-${project.id}`} onClick={() => toggle(project.id)}>
        <span className={`project-symbol ${project.id === 'gateway' ? 'blue' : project.id === 'design' ? 'purple' : ''}`}><FolderGit2 size={22} /></span>
        <span className="project-title"><strong>{project.name}</strong><span className="mono">{project.repository ?? '未确认 Git 仓库'}</span></span>
        <span className="project-counts">
          {countCurrent(project.sessions, 'waiting') > 0 && <span className="mini-count waiting">{countCurrent(project.sessions, 'waiting')} 等待</span>}
          {countCurrent(project.sessions, 'unread') > 0 && <span className="mini-count unread">{countCurrent(project.sessions, 'unread')} 未读</span>}
          {countCurrent(project.sessions, 'running') > 0 && <span className="mini-count running">{countCurrent(project.sessions, 'running')} 运行</span>}
          {unknown > 0 && <span className="mini-count unknown">{unknown} 未知</span>}
          {stale > 0 && <span className="mini-count stale">{stale} 缓存</span>}
        </span>
        <span className="project-updated">{relativeTime(project.activityAt)}</span><ChevronDown className={isCollapsed ? 'collapsed' : ''} size={17} />
      </button>
      {!isCollapsed && <div id={`project-${project.id}`}>
        {project.sessions.length === 0 && <div className="project-empty">该项目最近有活动，已读完成超过 24 小时的会话已隐藏。</div>}
        {project.sessions.map((session, index) => <div key={session.id}>
          {session.status === 'unknown' && (index === 0 || project.sessions[index - 1].status !== 'unknown') && <div className="unknown-divider">证据不足 · 需要确认的会话</div>}
          <SessionRow session={session} host={hosts.find((host) => host.id === session.hostId)} onOpen={onOpen} />
        </div>)}
      </div>}
    </section>;
  })}</div>;
}

function SessionRow({ session, host, onOpen }: { session: Session; host?: Host; onOpen: (id: string) => void }) {
  return <button className={`session-row ${session.status === 'unread' ? 'is-unread' : ''}`} onClick={() => onOpen(session.id)} aria-label={`查看 ${session.title}`}>
    <span className={`tool-symbol ${session.source === 'codex_cli' ? 'codex' : ''}`}><Terminal size={17} /></span>
    <span className="session-main"><strong>{session.title}{session.status === 'unread' && <span className="unread-dot" />}</strong>
      <span className="session-secondary"><span>{sourceLabels[session.source]}</span><span className="separator">/</span><GitBranch size={12} /><span className="mono">{session.branch ?? '分支未知'}</span></span>
      {session.reason && <span className="session-reason">{session.reason}</span>}
    </span>
    <span className="session-status"><StatusBadge session={session} />{session.freshness === 'stale' && <small><WifiOff size={11} />{host?.connection === 'offline' ? '主机离线' : '数据已过期'}</small>}</span>
    <span className="session-host">{host?.local ? <Monitor size={13} /> : <Server size={13} />}{host?.name ?? session.hostId ?? '主机未知'}</span>
    <span className="session-time">{relativeTime(session.activityAt)}</span><ChevronRight size={15} className="row-arrow" />
  </button>;
}
