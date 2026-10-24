import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, normalizeTarget } from '../src/store/memory.js';
import { createSeed } from '../src/store/seed.js';
import { validateModel } from '../src/models/contract.js';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const HOUR = 3600000;
const stores: MemoryStore[] = [];
const makeStore = (now = () => NOW, seed = createSeed(now())) => {
  const store = new MemoryStore(now, seed);
  stores.push(store);
  return store;
};
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });

describe('memory store', () => {
  it('seeds all five statuses, three sources, warnings and valid contract data', () => {
    const dashboard = makeStore().getDashboard();
    const sessions = dashboard.projects.flatMap(project => project.sessions);
    expect(new Set(sessions.map(session => session.status)).size).toBe(5);
    expect(new Set(sessions.map(session => session.source)).size).toBe(3);
    expect(dashboard.warnings[0].message).toContain('合成');
    expect(validateModel('Dashboard', dashboard)).toBe(true);
    expect(sessions.filter(session => session.projectId === 'board-demo').map(session => session.status)).toEqual(['waiting', 'unread', 'running', 'read']);
  });

  it('applies rolling project 7d boundary without filtering individual old sessions', () => {
    const seed = createSeed(NOW);
    seed.sessions = [{ ...seed.sessions[0], activityAt: new Date(NOW - 7 * 24 * HOUR).toISOString() }];
    expect(makeStore(() => NOW, seed).getDashboard().projects).toHaveLength(1);
    expect(makeStore(() => NOW + 1, seed).getDashboard().projects).toHaveLength(0);
    seed.sessions.push({ ...seed.sessions[0], id: 'newer', activityAt: new Date(NOW).toISOString() });
    expect(makeStore(() => NOW + 1, seed).getDashboard().projects[0].sessions).toHaveLength(2);
  });

  it('hides only read sessions completed more than 24h ago, preserving null completion', () => {
    const seed = createSeed(NOW);
    const completed = seed.sessions[1];
    seed.sessions = [
      { ...completed, id: 'boundary', status: 'read', completedAt: new Date(NOW - 24 * HOUR).toISOString() },
      { ...completed, id: 'old-read', status: 'read', completedAt: new Date(NOW - 24 * HOUR - 1).toISOString() },
      { ...completed, id: 'unread', completedAt: new Date(NOW - 25 * HOUR).toISOString() },
      { ...completed, id: 'unknown-time', status: 'read', completedAt: null },
    ];
    expect(makeStore(() => NOW, seed).getDashboard().projects[0].sessions.map(session => session.id)).toEqual(['unread', 'boundary', 'unknown-time']);
  });

  it('marks only matching fresh completed turns, idempotently without changing timestamps', () => {
    const store = makeStore();
    const before = store.getSession('demo-unread');
    expect(store.markRead(before.id, before.turnId!)).toMatchObject({ status: 'read', activityAt: before.activityAt, completedAt: before.completedAt });
    expect(store.markRead(before.id, before.turnId!)).toMatchObject({ status: 'read' });
    expect(() => store.markRead(before.id, 'old-turn')).toThrow(expect.objectContaining({ code: 'TURN_CHANGED' }));
    expect(() => store.markRead('demo-unknown', 'invented')).toThrow(expect.objectContaining({ code: 'TURN_ID_UNAVAILABLE' }));
    expect(() => store.markRead('demo-running', 'demo-running-turn-1')).toThrow(expect.objectContaining({ code: 'NOT_COMPLETED' }));
  });

  it('uses storage host for freshness, retains disabled caches, rejects stale read', () => {
    const seed = createSeed(NOW);
    seed.sessions[1].hostId = 'demo-offline';
    const store = makeStore(() => NOW, seed);
    expect(store.getSession('demo-unread').freshness).toBe('fresh');
    const stale = makeStore(() => NOW + 45001, seed);
    expect(() => stale.markRead('demo-unread', 'demo-unread-turn-1')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_STALE' }));
    store.setHostEnabled('demo-dev', false);
    expect(store.getDashboard().projects.flatMap(project => project.sessions).find(session => session.id === 'demo-running')?.freshness).toBe('stale');
  });

  it('removes storage-owned sessions but only unlinks remote workspace references', () => {
    const seed = createSeed(NOW);
    seed.sessions[1].hostId = 'demo-dev';
    const store = makeStore(() => NOW, seed);
    store.removeHost('demo-dev');
    expect(() => store.getSession('demo-running')).toThrow();
    expect(store.getSession('demo-unread').hostId).toBeNull();
    expect(() => store.removeHost('local')).toThrow(expect.objectContaining({ code: 'LOCAL_HOST_PROTECTED' }));
    expect(() => store.setHostEnabled('local', false)).toThrow();
  });

  it('coalesces asynchronous refresh without inventing connectivity or activity', async () => {
    vi.useFakeTimers();
    let now = NOW;
    const store = makeStore(() => now);
    const before = store.getSession('demo-unread').activityAt;
    const host = store.addHost('user@new-host');
    now += 20000;
    store.requestRefresh();
    store.requestRefresh();
    expect(vi.getTimerCount()).toBe(1);
    expect(store.getHosts().hosts.find(entry => entry.id === 'local')?.lastSuccessAt).toBe(new Date(NOW).toISOString());
    await vi.runAllTimersAsync();
    expect(store.getHosts().hosts.find(entry => entry.id === 'local')?.lastSuccessAt).toBe(new Date(now).toISOString());
    expect(store.getHosts().hosts.find(entry => entry.id === host.id)).toMatchObject({ connection: 'unknown', lastSuccessAt: null });
    expect(store.getSession('demo-unread').activityAt).toBe(before);
  });

  it('copies snapshots and resets state on restart', () => {
    const store = makeStore();
    const result = store.getHosts();
    result.hosts[0].name = 'changed';
    expect(store.getHosts().hosts[0].name).not.toBe('changed');
    store.markRead('demo-unread', 'demo-unread-turn-1');
    expect(makeStore().getSession('demo-unread').status).toBe('unread');
  });

  it.each(['-oProxyCommand=anything', 'host;whoami', 'host name', 'user@@host', 'host:22', 'a\nb', 'host\n', 'a/b', 'host$(cmd)', 'host&&cmd'])('rejects unsafe SSH target %s', target => {
    expect(() => normalizeTarget(target)).toThrow();
  });

  it('normalizes safe targets and rejects duplicates without touching SSH', () => {
    expect(normalizeTarget('User@HOST.example')).toBe('User@host.example');
    expect(normalizeTarget('dev_server')).toBe('dev_server');
    expect(normalizeTarget('[::1]')).toBe('::1');
    const store = makeStore();
    store.addHost('new-host');
    expect(() => store.addHost('NEW-HOST')).toThrow(expect.objectContaining({ code: 'HOST_EXISTS' }));
    expect(() => store.addHost('127.0.0.1')).toThrow();
  });
});
