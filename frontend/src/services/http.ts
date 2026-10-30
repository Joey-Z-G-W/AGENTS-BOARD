import * as api from './generated/board';
import type { BoardService } from './types';

export function createHttpService(baseUrl = '/api'): BoardService {
  const options = { baseUrl };
  return {
    mode: 'http',
    getDashboard: (signal, includeHistory) => api.getDashboard(includeHistory === undefined ? undefined : { includeHistory }, { ...options, signal }),
    getSession: (id, signal) => api.getSession(id, { ...options, signal }),
    markRead: (id, turnId) => api.markRead(id, { turnId }, options),
    getHosts: (signal) => api.getHosts({ ...options, signal }),
    addHost: (target) => api.addHost({ target }, options),
    setHostEnabled: (id, enabled) => api.setHostEnabled(id, { enabled }, options),
    removeHost: (id) => api.removeHost(id, options),
    refresh: () => api.refresh(options),
    requestSessionRefresh: (id, signal) => api.requestSessionRefresh(id, { ...options, signal }),
    getRefresh: (id, signal) => api.getRefresh(id, { ...options, signal }),
  };
}
