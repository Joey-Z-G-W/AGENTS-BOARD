export type SessionStatus = 'waiting' | 'unread' | 'running' | 'read' | 'unknown';
export type SourceType = 'codex_cli' | 'cursor_cli' | 'cursor_ide';
export type Freshness = 'fresh' | 'stale';

export interface Session {
  id: string;
  turnId: string;
  projectId: string;
  hostId: string;
  source: SourceType;
  title: string;
  status: SessionStatus;
  freshness: Freshness;
  activityAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  directory: string;
  branch: string | null;
  worktree: string | null;
  prompt: string;
  response: string | null;
  reason: string | null;
}

export interface Project {
  id: string;
  name: string;
  repository: string;
  activityAt: string;
  sessions: Session[];
}

export interface Host {
  id: string;
  name: string;
  address: string;
  local: boolean;
  enabled: boolean;
  connection: 'online' | 'offline';
  lastSuccessAt: string | null;
  error: string | null;
}

export interface SshCandidate {
  alias: string;
  address: string;
}

export interface Dashboard {
  projects: Project[];
  sampledAt: string;
}

export interface HostSettings {
  hosts: Host[];
  candidates: SshCandidate[];
}

export interface BoardService {
  readonly mode: 'mock' | 'http';
  getDashboard(): Promise<Dashboard>;
  getSession(id: string): Promise<Session>;
  markRead(id: string, turnId: string): Promise<Session>;
  getHosts(): Promise<HostSettings>;
  addHost(target: string): Promise<Host>;
  setHostEnabled(id: string, enabled: boolean): Promise<void>;
  removeHost(id: string): Promise<void>;
  refresh(): Promise<void>;
}

export class ServiceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
