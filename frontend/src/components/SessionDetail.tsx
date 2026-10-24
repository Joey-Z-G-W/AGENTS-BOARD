import { useEffect, useState } from 'react';
import { AlertCircle, Clock3, GitBranch, Terminal, WifiOff } from 'lucide-react';
import type { BoardService, Host, Session } from '../services';
import { dateTime, duration, sourceLabels } from '../lib/presentation';
import { errorMessage } from '../hooks/useBoard';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';

export function SessionDetail({ id, latestTurnId, service, hosts, onClose, onRead, stale }: {
  id: string; latestTurnId?: string; service: BoardService; hosts: Host[]; onClose: () => void; onRead: () => Promise<void>; stale: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setSession(null);
    setError(null);
    void (async () => {
      try {
        const detail = await service.getSession(id);
        if (!active) return;
        setSession(detail);
        if (detail.status === 'unread' && detail.completedAt) {
          const updated = await service.markRead(detail.id, detail.turnId);
          if (!active) return;
          setSession(updated);
          await onRead();
        }
      } catch (failure) { if (active) setError(errorMessage(failure)); }
    })();
    return () => { active = false; };
  }, [id, latestTurnId, service, onRead, retry]);

  const display = session && stale ? { ...session, freshness: 'stale' as const } : session;
  const host = hosts.find((entry) => entry.id === session?.hostId);
  return <Modal title="会话详情" onClose={onClose}>
    {error && <div className="notice error" role="alert"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
    {!display ? <div className="drawer-body"><h2 id="detail-heading">正在读取最新任务…</h2></div> : <div className="drawer-body">
      <div className="eyebrow"><Terminal size={14} />{sourceLabels[display.source]}<span className="separator">/</span>{host?.name ?? display.hostId}</div>
      <h2 id="detail-heading">{display.title}</h2>
      <div className="detail-status"><StatusBadge session={display} /><span><Clock3 size={14} />{duration(display)}</span></div>
      {display.freshness === 'stale' && <div className="notice"><WifiOff size={18} /><span>缓存快照，当前执行状态未验证。最近成功采集：{dateTime(host?.lastSuccessAt ?? null)}</span></div>}
      {display.reason && <div className={`notice ${display.status === 'waiting' ? 'attention' : ''}`}><AlertCircle size={18} /><span>{display.reason}</span></div>}
      <section className="message-section"><h3><span className="section-index">01</span>最新用户指令</h3><div className="message-content user-message">{display.prompt || '暂无可用指令'}</div></section>
      <section className="message-section"><h3><span className="section-index">02</span>Agent 最终响应</h3><div className={`message-content ${display.response ? '' : 'missing-message'}`}>{display.response ?? '尚无可用的最终响应。'}</div></section>
      <section className="message-section"><h3><span className="section-index">03</span>任务信息</h3><dl className="detail-metadata">
        <dt>工作目录</dt><dd className="mono">{display.directory}</dd>
        <dt>分支</dt><dd><GitBranch size={14} />{display.branch ?? '未知'}</dd>
        <dt>Worktree</dt><dd className="mono">{display.worktree ?? '未记录独立 worktree'}</dd>
        <dt>开始时间</dt><dd>{dateTime(display.startedAt)}</dd>
        <dt>完成时间</dt><dd>{dateTime(display.completedAt)}</dd>
        <dt>最近活动</dt><dd>{dateTime(display.activityAt)}</dd>
      </dl></section>
      <div className="detail-footnote">仅展示最新任务。需要回复或审批时，请前往原始 Agent 工具。</div>
    </div>}
  </Modal>;
}
