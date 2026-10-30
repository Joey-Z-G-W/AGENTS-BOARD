import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshSession } from './refreshSession';
import { createMockService } from './mock';
import type { BoardService } from './types';
import type { RefreshJob } from './generated/board';

afterEach(() => vi.useRealTimers());
async function fixture() {
  const mock = createMockService();
  const session = (await mock.getDashboard()).projects.flatMap(p => p.sessions).find(s => s.status === 'unread' && s.freshness === 'fresh')!;
  const job: RefreshJob = { id: 'job', sessionId: session.id, status: 'succeeded', requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), collectionVersion: { epoch: 'boot', sequence: 2 }, error: null };
  const service: BoardService = { ...mock, mode: 'http', requestSessionRefresh: vi.fn().mockResolvedValue(job), getRefresh: vi.fn().mockResolvedValue(job), getSession: vi.fn().mockResolvedValue({ ...session, collectionVersion: { epoch: 'boot', sequence: 3 }, collectedAt: new Date().toISOString() }), markRead: vi.fn() };
  return { service, session, job };
}

describe('real collection refresh protocol', () => {
  it('accepts a later version in the same epoch without marking anything read', async () => {
    const { service, session } = await fixture();
    const result = await refreshSession(service, session.id, new AbortController().signal);
    expect(result.collectionVersion?.sequence).toBe(3);
    expect(service.markRead).not.toHaveBeenCalled();
  });
  it('rejects a restarted epoch', async () => {
    const { service, session } = await fixture();
    vi.mocked(service.getSession).mockResolvedValue({ ...session, collectionVersion: { epoch: 'restart', sequence: 99 } });
    await expect(refreshSession(service, session.id, new AbortController().signal)).rejects.toMatchObject({ code: 'VERSION_CHANGED' });
  });
  it('keeps failed collection separate from successful cache reads', async () => {
    const { service, session, job } = await fixture();
    vi.mocked(service.requestSessionRefresh).mockResolvedValue({ ...job, status: 'failed', collectionVersion: null, error: { code: 'REFRESH_FAILED', message: 'fixture failure' } });
    await expect(refreshSession(service, session.id, new AbortController().signal)).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    expect(service.getSession).not.toHaveBeenCalled();
    expect(service.markRead).not.toHaveBeenCalled();
  });
  it('times out when detail never reaches the successful job version', async () => {
    const { service, session } = await fixture();
    vi.useFakeTimers();
    vi.mocked(service.getSession).mockResolvedValue({ ...session, collectionVersion: { epoch: 'boot', sequence: 1 } });
    const pending = expect(refreshSession(service, session.id, new AbortController().signal)).rejects.toMatchObject({ code: 'REFRESH_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(151_000);
    await pending;
    expect(service.markRead).not.toHaveBeenCalled();
  });
  it('cancels polling when a detail view closes', async () => {
    const { service, session, job } = await fixture();
    vi.useFakeTimers();
    vi.mocked(service.requestSessionRefresh).mockResolvedValue({ ...job, status: 'running', collectionVersion: null });
    const controller = new AbortController();
    const pending = expect(refreshSession(service, session.id, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await pending;
    expect(service.getRefresh).not.toHaveBeenCalled();
  });
  it('waits through a slow queued job and a full directed read', async () => {
    const { service, session, job } = await fixture();
    vi.useFakeTimers();
    const started = Date.now();
    vi.mocked(service.requestSessionRefresh).mockResolvedValue({ ...job, status: 'queued', collectionVersion: null });
    vi.mocked(service.getRefresh).mockImplementation(async () => {
      const elapsed = Date.now() - started;
      if (elapsed < 50_000) return { ...job, status: 'queued', collectionVersion: null };
      if (elapsed < 110_000) return { ...job, status: 'running', collectionVersion: null };
      return job;
    });
    const pending = refreshSession(service, session.id, new AbortController().signal);
    const completed = expect(pending).resolves.toMatchObject({ collectionVersion: { epoch: 'boot', sequence: 3 } });
    await vi.advanceTimersByTimeAsync(109_000);
    expect(service.getSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await completed;
    expect(service.markRead).not.toHaveBeenCalled();
  });
  it('mock merges active jobs, creates new terminal jobs and expires them', async () => {
    let now = Date.now();
    const service = createMockService({ now: () => now });
    const session = (await service.getDashboard()).projects.flatMap(p => p.sessions).find(s => s.status === 'unread' && s.freshness === 'fresh')!;
    const first = await service.requestSessionRefresh(session.id);
    expect((await service.requestSessionRefresh(session.id)).id).toBe(first.id);
    expect((await service.getRefresh(first.id)).status).toBe('running');
    expect((await service.getRefresh(first.id)).status).toBe('succeeded');
    expect((await service.requestSessionRefresh(session.id)).id).not.toBe(first.id);
    now += 600_001;
    await expect(service.getRefresh(first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
