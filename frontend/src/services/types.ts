import type { Dashboard, Host, HostSettings, Session } from './generated/board';

export type { Dashboard, Host, HostSettings, Project, Session, SshCandidate, SessionStatus } from './generated/board';
export type SourceType = Session['source'];
export type Freshness = Session['freshness'];

export interface BoardService {
  readonly mode: 'mock' | 'http';
  getDashboard(signal?: AbortSignal): Promise<Dashboard>;
  getSession(id: string, signal?: AbortSignal): Promise<Session>;
  markRead(id: string, turnId: string): Promise<Session>;
  getHosts(signal?: AbortSignal): Promise<HostSettings>;
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
