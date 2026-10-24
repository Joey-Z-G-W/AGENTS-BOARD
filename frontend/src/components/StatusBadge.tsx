import type { Session } from '../services';
import { statusLabels } from '../lib/presentation';

export function StatusBadge({ session }: { session: Session }) {
  return <span className={`status-badge ${session.freshness === 'stale' ? 'stale' : session.status}`}>
    <span className="status-dot" />{session.freshness === 'stale' ? `上次：${statusLabels[session.status]}` : statusLabels[session.status]}
  </span>;
}
