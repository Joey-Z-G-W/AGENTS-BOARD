import { createHttpService } from './http';
import { createMockService } from './mock';

function browserStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

export const boardService = import.meta.env.VITE_SERVICE_MODE === 'http'
  ? createHttpService(import.meta.env.VITE_API_BASE_URL || '/api')
  : createMockService({ storage: browserStorage(), latency: 180 });

export type { BoardService, Dashboard, Host, HostSettings, Project, Session, SessionStatus } from './types';
