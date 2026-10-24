import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from '../models/errors.js';
import type { Dashboard, Host, Session, State, Warning } from '../models/types.js';
import { createSeed } from './seed.js';

const HOUR = 3600000;
const priority = { waiting: 0, unread: 1, running: 2, read: 3, unknown: 4 };
const timestamp = (value: string | null) => value === null ? -Infinity : Date.parse(value);
const syntheticWarning: Warning = { code: 'PARTIAL_COLLECTION', hostId: null, source: null, message: '内存演示后端：数据为合成样本，刷新不执行真实 Agent 采集或 SSH；重启会重置。' };

export function normalizeTarget(target: string): string {
  const parts = target.split('@');
  if (parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parts[0]))) {
    throw new ApiError(400, 'INVALID_TARGET', '请输入有效 SSH 别名或 user@host。');
  }
  const hostname = parts.at(-1)!;
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const domainValid = hostname.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (!target || target.length > 255 || (!isIP(unbracketed) && !domainValid)) {
    throw new ApiError(400, 'INVALID_TARGET', '目标不能包含选项、端口、空白或 shell 语法。');
  }
  return (parts.length === 2 ? parts[0] + '@' : '') + unbracketed.toLowerCase();
}

export class MemoryStore {
  private readonly state: State;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private readonly demoOnlineHosts: Set<string>;

  constructor(private readonly now = Date.now, seed = createSeed(now())) {
    this.state = structuredClone(seed);
    this.demoOnlineHosts = new Set(seed.hosts.filter(host => host.connection === 'online').map(host => host.id));
  }

  private host(id: string) {
    const host = this.state.hosts.find(entry => entry.id === id);
    if (!host) throw new ApiError(404, 'NOT_FOUND', '主机不存在。');
    return host;
  }

  private session(id: string) {
    const session = this.state.sessions.find(entry => entry.id === id);
    if (!session) throw new ApiError(404, 'NOT_FOUND', '会话不存在。');
    return session;
  }

  private snapshot(session: Session): Session {
    const host = this.state.hosts.find(entry => entry.id === session.storageHostId);
    const stale = !host?.enabled || host.connection !== 'online' || !host.lastSuccessAt || this.now() - timestamp(host.lastSuccessAt) > 45000;
    return structuredClone({ ...session, freshness: stale ? 'stale' : session.freshness, reason: stale ? '存储主机不可用、停用或采集过期；仅显示最后样本。' : session.reason });
  }

  getSession(id: string) { return this.snapshot(this.session(id)); }

  getDashboard(): Dashboard {
    const projects = this.state.projects.flatMap(project => {
      const allSessions = this.state.sessions.filter(session => session.projectId === project.id);
      if (!allSessions.length) return [];
      const activity = Math.max(...allSessions.map(session => timestamp(session.activityAt)));
      const unknownTime = allSessions.some(session => session.activityAt === null);
      if (!unknownTime && this.now() - activity > 7 * 24 * HOUR) return [];
      return [{
        ...project,
        activityAt: Number.isFinite(activity) ? new Date(activity).toISOString() : null,
        sessions: allSessions.filter(session => !(session.status === 'read' && session.completedAt && this.now() - timestamp(session.completedAt) > 24 * HOUR))
          .map(session => this.snapshot(session))
          .sort((left, right) => priority[left.status] - priority[right.status] || timestamp(right.activityAt) - timestamp(left.activityAt)),
      }];
    }).sort((left, right) => timestamp(right.activityAt) - timestamp(left.activityAt));
    const warnings: Warning[] = [syntheticWarning];
    for (const host of this.state.hosts) {
      if (host.enabled && host.connection !== 'online') warnings.push({ code: 'PARTIAL_COLLECTION', hostId: host.id, source: null, message: host.error ?? '尚无成功采集。' });
    }
    if (this.state.sessions.some(session => session.activityAt === null)) {
      warnings.push({ code: 'TIME_UNVERIFIED', hostId: null, source: null, message: '部分任务无可靠活动时间，保守保留，不伪造 7 天过滤依据。' });
    }
    return structuredClone({ projects, warnings, sampledAt: new Date(this.now()).toISOString() });
  }

  markRead(id: string, turnId: string) {
    const session = this.session(id);
    if (!session.turnId) throw new ApiError(409, 'TURN_ID_UNAVAILABLE', '无法确定最新任务。');
    if (session.turnId !== turnId) throw new ApiError(409, 'TURN_CHANGED', '任务已更新，请重新打开详情。');
    if (this.snapshot(session).freshness === 'stale') throw new ApiError(409, 'SNAPSHOT_STALE', '采集样本已过期，不能确认最新任务。');
    if (!['read', 'unread'].includes(session.status)) throw new ApiError(409, 'NOT_COMPLETED', '任务尚未确认完成。');
    session.status = 'read';
    session.evidence = { ...session.evidence, basis: 'web_read' };
    return this.snapshot(session);
  }

  getHosts() { return structuredClone({ hosts: this.state.hosts, candidates: this.state.candidates }); }

  addHost(target: string): Host {
    const address = normalizeTarget(target);
    if (this.state.hosts.some(host => normalizeTarget(host.address) === address) || ['localhost', '127.0.0.1', '::1'].includes(address.split('@').at(-1)!)) {
      throw new ApiError(409, 'HOST_EXISTS', '监控目标已存在。');
    }
    const host: Host = { id: randomUUID(), name: target, address, local: false, enabled: true, connection: 'unknown', lastSuccessAt: null, error: '真实采集未实现；仅保存内存监控配置。' };
    this.state.hosts.push(host);
    this.requestRefresh();
    return structuredClone(host);
  }

  setHostEnabled(id: string, enabled: boolean) {
    const host = this.host(id);
    if (host.local && !enabled) throw new ApiError(409, 'LOCAL_HOST_PROTECTED', '本机不能停用。');
    host.enabled = enabled;
    if (enabled) this.requestRefresh();
  }

  removeHost(id: string) {
    if (this.host(id).local) throw new ApiError(409, 'LOCAL_HOST_PROTECTED', '本机不能删除。');
    this.state.hosts = this.state.hosts.filter(host => host.id !== id);
    this.state.sessions = this.state.sessions.filter(session => session.storageHostId !== id)
      .map(session => session.hostId === id ? { ...session, hostId: null } : session);
    this.demoOnlineHosts.delete(id);
  }

  requestRefresh() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const host of this.state.hosts) {
        if (host.enabled && this.demoOnlineHosts.has(host.id)) host.lastSuccessAt = new Date(this.now()).toISOString();
      }
    }, 0);
  }

  close() {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
  }
}
