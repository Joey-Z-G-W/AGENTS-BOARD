export type Status = 'waiting' | 'unread' | 'running' | 'read' | 'unknown';
export type Source = 'codex_cli' | 'cursor_cli' | 'cursor_ide';
export type Capability = 'verified' | 'candidate' | 'unavailable';

export interface Evidence {
  level: 'observed' | 'inferred' | 'unavailable';
  basis: 'native_task_event' | 'composer_status' | 'web_read' | 'initial_import' | 'unsupported' | 'conflicting';
  observedAt: string | null;
  sourceVersion: string | null;
  reason: string | null;
}

export interface Session {
  id: string;
  turnId: string | null;
  turnIdentityKind: 'native' | 'derived' | 'unavailable';
  projectId: string;
  hostId: string | null;
  storageHostId: string;
  source: Source;
  title: string;
  status: Status;
  freshness: 'fresh' | 'stale';
  activityAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  directory: string | null;
  branch: string | null;
  worktree: string | null;
  prompt: string | null;
  response: string | null;
  reason: string | null;
  evidence: Evidence;
  capabilities: Record<'latestTurn' | 'waiting' | 'finalResponse' | 'nativeRead' | 'exactCompletionTime', Capability>;
}

export interface Project {
  id: string;
  name: string;
  repository: string | null;
  identityKind: 'git_remote' | 'git_common_dir' | 'host_directory' | 'unresolved';
  activityAt: string | null;
  sessions: Session[];
}

export interface Host {
  id: string;
  name: string;
  address: string;
  local: boolean;
  enabled: boolean;
  connection: 'online' | 'offline' | 'unknown';
  lastSuccessAt: string | null;
  error: string | null;
}

export interface Warning {
  code: 'PARTIAL_COLLECTION' | 'SOURCE_UNSUPPORTED' | 'TIME_UNVERIFIED' | 'WORKSPACE_UNRESOLVED';
  hostId: string | null;
  source: Source | null;
  message: string;
}

export interface Dashboard {
  projects: Project[];
  sampledAt: string;
  warnings: Warning[];
}

export interface State {
  projects: Omit<Project, 'activityAt' | 'sessions'>[];
  sessions: Session[];
  hosts: Host[];
  candidates: { alias: string; address: string }[];
}

export interface Credentials { username: string; password: string }
