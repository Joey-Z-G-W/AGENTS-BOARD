import { createSeed, type MockState } from './seed';
import { ServiceError, type BoardService, type Host, type Session } from './types';

const STORAGE_KEY = 'agents-board.mock.v1';
const HOUR = 3_600_000;
const priority = { waiting: 0, unread: 1, running: 2, read: 3, unknown: 4 };

interface MockOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  initialState?: MockState;
  now?: () => number;
  latency?: number;
}

export function createMockService(options: MockOptions = {}): BoardService {
  const now = options.now ?? Date.now;
  let state = structuredClone(options.initialState ?? createSeed(now()));
  try {
    const stored = options.storage?.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: MockState = JSON.parse(stored);
      if (parsed.version === 1 && Array.isArray(parsed.sessions) && Array.isArray(parsed.hosts) && Array.isArray(parsed.projects) && Array.isArray(parsed.candidates)) state = parsed;
    }
  } catch {
    state = structuredClone(options.initialState ?? createSeed(now()));
  }
  const persist = () => {
    try { options.storage?.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { throw new ServiceError('浏览器存储不可用，修改未保存。请允许本站使用本地存储。', 'STORAGE'); }
  };
  const commit = (next: MockState) => {
    const previous = state;
    state = next;
    try { persist(); } catch (error) { state = previous; throw error; }
  };
  const pause = async () => {
    if (options.latency) await new Promise((resolve) => setTimeout(resolve, options.latency));
  };
  const findSession = (id: string) => {
    const session = state.sessions.find((entry) => entry.id === id);
    if (!session) throw new ServiceError('会话已不存在，请刷新看板。', 'NOT_FOUND');
    return session;
  };
  const findHost = (id: string) => {
    const host = state.hosts.find((entry) => entry.id === id);
    if (!host) throw new ServiceError('主机已不存在。', 'NOT_FOUND');
    return host;
  };
  const withFreshness = (session: Session): Session => {
    const host = state.hosts.find((entry) => entry.id === session.hostId);
    const stale = !host || !host.enabled || host.connection === 'offline' || !host.lastSuccessAt || now() - Date.parse(host.lastSuccessAt) > 45_000;
    return { ...session, freshness: stale ? 'stale' : session.freshness };
  };
  let refreshing: Promise<void> | null = null;

  return {
    mode: 'mock',
    async getDashboard() {
      await pause();
      if (now() - Date.parse(state.sampledAt) >= 15_000) {
        const sampledAt = new Date(now()).toISOString();
        state = { ...state, sampledAt, hosts: state.hosts.map((host) => host.enabled && host.connection === 'online' ? { ...host, lastSuccessAt: sampledAt } : host) };
      }
      const enabled = new Set(state.hosts.filter((host) => host.enabled).map((host) => host.id));
      const projects = state.projects.map((project) => {
        const allSessions = state.sessions.filter((session) => session.projectId === project.id && session.hostId !== null && enabled.has(session.hostId));
        const activity = Math.max(...allSessions.map((session) => session.activityAt ? Date.parse(session.activityAt) : -Infinity));
        return {
          ...project,
          identityKind: 'git_remote' as const,
          activityAt: Number.isFinite(activity) ? new Date(activity).toISOString() : new Date(0).toISOString(),
          sessions: allSessions.filter((session) => !(session.status === 'read' && session.completedAt && now() - Date.parse(session.completedAt) > 24 * HOUR))
            .map(withFreshness).sort((left, right) => priority[left.status] - priority[right.status] || Date.parse(right.activityAt ?? '') - Date.parse(left.activityAt ?? '')),
        };
      }).filter((project) => now() - Date.parse(project.activityAt) <= 7 * 24 * HOUR)
        .sort((left, right) => Date.parse(right.activityAt) - Date.parse(left.activityAt));
      return structuredClone({ projects, sampledAt: state.sampledAt, warnings: [] });
    },
    async getSession(id) {
      await pause();
      return structuredClone(withFreshness(findSession(id)));
    },
    async markRead(id, turnId) {
      await pause();
      const session = findSession(id);
      if (session.turnId !== turnId) throw new ServiceError('此会话已开始新任务，请重新打开查看。', 'CONFLICT');
      if (!session.completedAt || !['read', 'unread'].includes(session.status)) throw new ServiceError('只有已完成的任务可以标记为已读。', 'NOT_COMPLETE');
      const updated: Session = { ...session, status: 'read' };
      commit({ ...state, sessions: state.sessions.map((entry) => entry.id === id ? updated : entry) });
      return structuredClone(withFreshness(updated));
    },
    async getHosts() {
      await pause();
      return structuredClone({ hosts: state.hosts, candidates: state.candidates });
    },
    async addHost(target) {
      await pause();
      const name = target.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/.test(name)) throw new ServiceError('请输入有效的 SSH 别名或 user@host，不包含空格或命令。', 'VALIDATION');
      const candidate = state.candidates.find((entry) => entry.alias === name);
      const address = candidate?.address ?? name;
      if (state.hosts.some((host) => host.id === name || host.name === name || host.address === address)) throw new ServiceError('该主机已在监控列表中。', 'DUPLICATE');
      const host: Host = { id: name, name, address, local: false, enabled: true, connection: 'online', lastSuccessAt: new Date(now()).toISOString(), error: null };
      commit({ ...state, hosts: [...state.hosts, host] });
      return structuredClone(host);
    },
    async setHostEnabled(id, enabled) {
      await pause();
      const host = findHost(id);
      if (host.local && !enabled) throw new ServiceError('本机始终自动监控。', 'LOCAL_HOST');
      commit({ ...state, hosts: state.hosts.map((entry) => entry.id === id ? { ...entry, enabled } : entry) });
    },
    async removeHost(id) {
      await pause();
      if (findHost(id).local) throw new ServiceError('无法移除本机。', 'LOCAL_HOST');
      commit({ ...state, hosts: state.hosts.filter((entry) => entry.id !== id) });
    },
    refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        await pause();
        const sampledAt = new Date(now()).toISOString();
        commit({ ...state, sampledAt, hosts: state.hosts.map((host) => host.enabled && host.connection === 'online' ? { ...host, lastSuccessAt: sampledAt } : host) });
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
  };
}
