import type { Session, SessionStatus } from '../services';

export const statusLabels: Record<SessionStatus, string> = {
  waiting: '等待处理', unread: '完成 · 未读', running: '正在运行', read: '已读', unknown: '状态未知',
};

export const sourceLabels = { codex_cli: 'Codex CLI', codex_desktop: 'Codex 桌面', cursor_cli: 'Cursor CLI', cursor_ide: 'Cursor IDE' };

export function relativeTime(value: string | null, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function dateTime(value: string | null) {
  if (!value) return '暂无可靠记录';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function duration(session: Session) {
  if (session.durationSeconds !== null) {
    const seconds = session.durationSeconds;
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }
  return session.completedAt ? '暂无可靠记录' : '尚未完成';
}

export function countCurrent(sessions: Session[], status: SessionStatus) {
  return sessions.filter((session) => session.status === status && session.freshness === 'fresh').length;
}
