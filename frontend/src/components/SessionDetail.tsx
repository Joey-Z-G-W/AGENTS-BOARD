import { useEffect, useState } from 'react';
import { AlertCircle, Clock3, GitBranch, Terminal, WifiOff } from 'lucide-react';
import type { BoardService, Host, Session } from '../services';
import { dateTime, duration, sourceLabels } from '../lib/presentation';
import { errorMessage } from '../hooks/useBoard';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { refreshSession } from '../services/refreshSession';

export function SessionDetail({ id, latestTurnId, service, hosts, onClose, onRead, stale }: {
  id: string; latestTurnId?: string | null; service: BoardService; hosts: Host[]; onClose: () => void; onRead: () => Promise<void>; stale: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError(null);
    setChecking(true);
    void (async () => {
      try {
        const cached = await service.getSession(id, controller.signal);
        if (!active) return;
        setSession(cached);
        const detail = await refreshSession(service, id, controller.signal);
        if (!active) return;
        setSession(detail);
        // Let React display this exact completed turn before sending markRead.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!active) return;
        if (detail.status === 'unread' && detail.turnId && detail.freshness === 'fresh' && !stale) {
          const updated = await service.markRead(detail.id, detail.turnId);
          if (!active) return;
          setSession(updated);
          await onRead();
        }
      } catch (failure) { if (active) setError(errorMessage(failure)); }
      finally { if (active) setChecking(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [id, latestTurnId, service, onRead, retry, stale]);

  const display = session && stale ? { ...session, freshness: 'stale' as const } : session;
  const host = hosts.find((entry) => entry.id === session?.hostId);
  const storageHost = hosts.find((entry) => entry.id === (session?.storageHostId ?? session?.hostId));
  return <Modal title="会话详情" onClose={onClose}>
    {checking && <div role="status" className="detail-footnote">正在重新检查来源…</div>}
    {error && <div className="notice error" role="alert"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
    {!display ? <div className="drawer-body"><h2 id="detail-heading">正在读取最新任务…</h2></div> : <div className="drawer-body">
      <div className="eyebrow"><Terminal size={14} />{sourceLabels[display.source]}<span className="separator">/</span>{host?.name ?? display.hostId ?? '执行主机未知'}</div>
      <h2 id="detail-heading">{display.title}</h2>
      <div className="detail-status"><StatusBadge session={display} /><span><Clock3 size={14} />{duration(display)}</span></div>
      {display.freshness === 'stale' && <div className="notice"><WifiOff size={18} /><span>缓存快照，当前执行状态未验证。最近成功采集：{dateTime(display.collectedAt ?? null)}</span></div>}
      <details className="detail-footnote"><summary>采集详情 · {dateTime(display.collectedAt ?? null)}</summary><p>{display.reason ?? '最近检查已完成。'}</p><p>{display.evidence.reason}</p></details>
      <section className="message-section"><h3><span className="section-index">01</span>最新用户指令</h3><div className="message-content user-message">{display.prompt || '暂无可用指令'}</div></section>
      <section className="message-section"><h3><span className="section-index">02</span>Agent 最终响应</h3><div className={`message-content ${display.response ? '' : 'missing-message'}`}>{display.response ?? '尚无可用的最终响应。'}</div></section>
      <section className="message-section"><h3><span className="section-index">03</span>任务信息</h3><dl className="detail-metadata">
        <dt>工作目录</dt><dd className="mono">{display.directory ?? '暂无可靠记录'}</dd>
        <dt>记录存储主机</dt><dd>{storageHost?.name ?? '未知'}</dd>
        <dt>分支</dt><dd><GitBranch size={14} />{display.branch ?? '未知'}</dd>
        <dt>Worktree</dt><dd className="mono">{display.worktree ?? '未记录独立 worktree'}</dd>
        <dt>开始时间</dt><dd>{dateTime(display.startedAt)}</dd>
        <dt>完成时间</dt><dd>{dateTime(display.completedAt)}</dd>
        <dt>最近活动</dt><dd>{dateTime(display.activityAt)}</dd>
      </dl></section>
      {(display.source === 'codex_cli' || display.source === 'codex_desktop') && storageHost?.local && <Subagents collection={display.subagents} />}
      <div className="detail-footnote">仅展示最新任务。需要回复或审批时，请前往原始 Agent 工具。</div>
    </div>}
  </Modal>;
}


function Subagents({ collection }: { collection: Session['subagents'] }) {
  const oldScan = collection && Date.now() - Date.parse(collection.scannedAt) > 45_000;
  return <section className="message-section" aria-label="此会话的直接子代理">
    <h3><span className="section-index">04</span>此会话的直接子代理</h3>
    <p className="detail-footnote">可能跨任务轮次。展示后台最近采集结果，父会话刷新和已读不会刷新或标记子代理。</p>
    {!collection ? <p>尚未扫描子代理。</p> : <>
      <p className="detail-footnote">子代理扫描时间：{dateTime(collection.scannedAt)}{oldScan ? ' · 扫描缓存已过期' : ''}</p>
      {collection.status === 'partial' && <p className="notice">扫描尚未完整覆盖或达到读取预算；当前列表可能不完整。</p>}
      {collection.status === 'error' && <p className="notice">子代理记录读取失败；保留可用的旧样本，当前列表可能不完整。</p>}
      {collection.items.length === 0 && <p>{collection.status === 'complete' && !oldScan ? '本次扫描未发现直接子代理记录。' : '当前缓存没有可展示的直接子代理，不能确认不存在。'}</p>}
      {collection.items.map(child => <details className="subagent-detail" key={child.nativeId}>
        <summary>{child.nickname || child.path || child.nativeId} · {{ unknown: '未知', completed: '已完成', interrupted: '已中断' }[child.status]}{child.freshness === 'stale' || Date.now() - Date.parse(child.collectedAt) > 45_000 ? ' · 陈旧样本' : ''}</summary>
        <dl className="detail-metadata">
          <dt>代理路径</dt><dd>{child.path || '未知'}</dd>
          <dt>角色</dt><dd>{child.role || '未知'}</dd>
          <dt>实际模型</dt><dd>{child.model || '未知'}</dd>
          <dt>推理强度</dt><dd>{child.effort || '未知'}</dd>
          <dt>模型证据时间</dt><dd>{dateTime(child.modelObservedAt)}</dd>
          <dt>开始时间</dt><dd>{dateTime(child.startedAt)}</dd>
          <dt>完成时间</dt><dd>{dateTime(child.completedAt)}</dd>
          <dt>最近活动</dt><dd>{dateTime(child.activityAt)}</dd>
          <dt>独立采集时间</dt><dd>{dateTime(child.collectedAt)}</dd>
        </dl>
        <p className="detail-footnote">{child.reason || '状态依据未知。'}</p>
        <h4>最新任务摘要</h4><div className="message-content user-message">{child.prompt || '未知'}</div>
        <h4>最终结果</h4><div className="message-content">{child.response || '暂无可用的最终结果。'}</div>
      </details>)}
    </>}
  </section>;
}
