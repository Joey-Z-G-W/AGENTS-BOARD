import { describe, expect, it, vi } from 'vitest';
import { createMockService } from './mock';
import { createSeed } from './seed';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const HOUR = 3_600_000;
const makeService = () => createMockService({ now: () => NOW });

describe('Mock service: dashboard rules', () => {
  it('counts and filters cross-host sessions by their storage host consistently', async () => {
    const seed = createSeed(NOW);
    seed.sessions = [seed.sessions[0]];
    seed.sessions[0].storageHostId = 'dev-server';
    seed.sessions[0].hostId = 'local';
    const service = createMockService({ now: () => NOW, initialState: seed });
    await service.setHostEnabled('dev-server', false);
    const dashboard = await service.getDashboard(undefined, true);
    expect(dashboard.projects.flatMap(project => project.sessions)).toHaveLength(0);
    for (const count of dashboard.sourceCounts ?? []) {
      expect(count.hidden).toBeGreaterThanOrEqual(0);
      expect(count.collected).toBe(count.visible + count.hidden);
    }
  });
  it('groups native sessions once, sorts projects by activity and sessions by attention', async () => {
    const dashboard = await makeService().getDashboard();
    expect(dashboard.projects.map((project) => project.id)).toEqual(['board', 'gateway', 'design']);
    expect(dashboard.projects[0].sessions.map((session) => session.status)).toEqual(['waiting', 'unread', 'running']);
    expect(dashboard.projects[1].sessions.map((session) => session.id)).toEqual(['gateway-rate', 'gateway-cache', 'gateway-unknown']);
    const sessions = dashboard.projects.flatMap((project) => project.sessions);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(sessions.length);
  });

  it('keeps the seven-day boundary and hides projects older than it', async () => {
    const seed = createSeed(NOW);
    seed.sessions = seed.sessions.filter((session) => session.id === 'board-api');
    seed.sessions[0].activityAt = new Date(NOW - 7 * 24 * HOUR).toISOString();
    expect((await createMockService({ now: () => NOW, initialState: seed }).getDashboard()).projects).toHaveLength(1);
    seed.sessions[0].activityAt = new Date(NOW - 7 * 24 * HOUR - 1).toISOString();
    expect((await createMockService({ now: () => NOW, initialState: seed }).getDashboard()).projects).toHaveLength(0);
  });

  it('hides only Read tasks completed more than 24 hours ago, not Unread tasks', async () => {
    const seed = createSeed(NOW);
    const read = seed.sessions.find((session) => session.id === 'design-docs')!;
    const unread = seed.sessions.find((session) => session.id === 'design-tokens')!;
    read.completedAt = new Date(NOW - 24 * HOUR).toISOString();
    unread.completedAt = new Date(NOW - 48 * HOUR).toISOString();
    const atBoundary = await createMockService({ now: () => NOW, initialState: seed }).getDashboard();
    expect(atBoundary.projects.find((project) => project.id === 'design')!.sessions).toHaveLength(2);
    read.completedAt = new Date(NOW - 24 * HOUR - 1).toISOString();
    const afterBoundary = await createMockService({ now: () => NOW, initialState: seed }).getDashboard();
    expect(afterBoundary.projects.find((project) => project.id === 'design')!.sessions.map((session) => session.id)).toEqual(['design-tokens']);
  });

  it('preserves project activity even when its finished sessions are hidden', async () => {
    const seed = createSeed(NOW);
    seed.sessions = [{ ...seed.sessions[1], status: 'read', activityAt: new Date(NOW - 25 * HOUR).toISOString(), completedAt: new Date(NOW - 25 * HOUR).toISOString() }];
    const result = await createMockService({ now: () => NOW, initialState: seed }).getDashboard();
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].sessions).toHaveLength(0);
  });

  it('keeps offline Running as stale evidence, including after a manual refresh', async () => {
    const service = makeService();
    await service.refresh();
    expect(await service.getSession('gateway-cache')).toMatchObject({ status: 'running', freshness: 'stale' });
    expect((await service.getHosts()).hosts.find((host) => host.id === 'gpu-lab')).toMatchObject({ connection: 'offline', lastSuccessAt: new Date(NOW - 46 * 60_000).toISOString() });
  });
});

describe('Mock service: read persistence and concurrency', () => {
  it('persists a read marker across service instances without changing agent activity', async () => {
    const service = createMockService({ storage: localStorage, now: () => NOW });
    const before = await service.getSession('board-ui');
    await service.markRead(before.id, before.turnId!);
    const restored = createMockService({ storage: localStorage, now: () => NOW });
    expect(await restored.getSession(before.id)).toMatchObject({ status: 'read', activityAt: before.activityAt, completedAt: before.completedAt });
    await expect(restored.markRead(before.id, before.turnId!)).resolves.toMatchObject({ status: 'read' });
  });

  it('rejects an obsolete task read marker without consuming the new unread task', async () => {
    const service = makeService();
    await expect(service.markRead('board-ui', 'old-turn')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await service.getSession('board-ui')).status).toBe('unread');
  });

  it('does not mark a running or unknown task as completed', async () => {
    const service = makeService();
    await expect(service.markRead('board-api', 'board-api-turn-1')).rejects.toMatchObject({ code: 'NOT_COMPLETE' });
    await expect(service.markRead('gateway-unknown', 'gateway-unknown-turn-1')).rejects.toMatchObject({ code: 'NOT_COMPLETE' });
  });

  it('reports missing sessions and recovers from invalid persisted JSON', async () => {
    localStorage.setItem('agents-board.mock.v1', '{bad');
    const service = createMockService({ storage: localStorage, now: () => NOW });
    expect((await service.getDashboard()).projects).toHaveLength(3);
    await expect(service.getSession('absent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rolls back a mutation if local persistence fails', async () => {
    const service = createMockService({ now: () => NOW, storage: { getItem: () => null, setItem: () => { throw new Error('Quota'); } } });
    await expect(service.markRead('board-ui', 'board-ui-turn-1')).rejects.toMatchObject({ code: 'STORAGE' });
    expect((await service.getSession('board-ui')).status).toBe('unread');
  });

  it('coalesces overlapping refreshes', async () => {
    vi.useFakeTimers();
    const service = createMockService({ now: () => NOW, latency: 100 });
    const first = service.refresh();
    const second = service.refresh();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(100);
    await first;
  });
});

describe('Mock service: hosts', () => {
  it('persists host changes and excludes disabled hosts from dashboard projections', async () => {
    const service = createMockService({ storage: localStorage, now: () => NOW });
    await service.setHostEnabled('dev-server', false);
    expect((await service.getDashboard()).projects.flatMap((project) => project.sessions).some((session) => session.hostId === 'dev-server')).toBe(false);
    expect((await createMockService({ storage: localStorage, now: () => NOW }).getHosts()).hosts.find((host) => host.id === 'dev-server')!.enabled).toBe(false);
  });

  it('imports an alias, rejects duplicates and rejects command-like input', async () => {
    const service = makeService();
    expect(await service.addHost('staging')).toMatchObject({ name: 'staging', address: 'joey@staging.internal' });
    await expect(service.addHost('staging')).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(service.addHost('server; echo secret')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.addHost('local')).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('protects localhost from removal or disabling', async () => {
    const service = makeService();
    await expect(service.removeHost('local')).rejects.toMatchObject({ code: 'LOCAL_HOST' });
    await expect(service.setHostEnabled('local', false)).rejects.toMatchObject({ code: 'LOCAL_HOST' });
  });

  it('restores the stable session namespace when a removed host is re-added', async () => {
    const service = makeService();
    await service.removeHost('dev-server');
    expect((await service.getDashboard()).projects.flatMap((project) => project.sessions).some((session) => session.id === 'board-api')).toBe(false);
    await service.addHost('dev-server');
    expect((await service.getDashboard()).projects.flatMap((project) => project.sessions).filter((session) => session.id === 'board-api')).toHaveLength(1);
  });

  it('returns independent snapshots that cannot mutate service state', async () => {
    const service = makeService();
    const hosts = await service.getHosts();
    hosts.hosts[0].name = 'changed';
    const session = await service.getSession('board-ui');
    session.status = 'read';
    expect((await service.getHosts()).hosts[0].name).toBe('本机');
    expect((await service.getSession('board-ui')).status).toBe('unread');
  });
});
