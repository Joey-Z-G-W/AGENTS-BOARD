import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockService } from '../services/mock';
import { createSeed } from '../services/seed';
import { SessionDetail } from './SessionDetail';

describe('Session detail task changes', () => {
  it.each([{ turnId: null, freshness: 'fresh' }, { turnId: 'known-turn', freshness: 'stale' }])('does not mark missing or stale turn identities read: %j', async overrides => {
    const seed = createSeed();
    const service = createMockService({ initialState: seed });
    service.getSession = vi.fn().mockResolvedValue({ ...seed.sessions[1], ...overrides, hostId: null, storageHostId: 'local', directory: null, prompt: null, activityAt: null });
    service.markRead = vi.fn();
    render(<SessionDetail id="board-ui" service={service} hosts={seed.hosts} onClose={vi.fn()} onRead={vi.fn()} stale={false} />);
    expect(await screen.findByText(/执行主机未知/)).toBeInTheDocument();
    expect(screen.getByText('暂无可用指令')).toBeInTheDocument();
    expect(service.markRead).not.toHaveBeenCalled();
  });

  it('replaces an open task when polling discovers a newer turn in the same session', async () => {
    const seed = createSeed();
    const service = createMockService({ initialState: seed });
    const onRead = vi.fn().mockResolvedValue(undefined);
    const initial = seed.sessions.find((session) => session.id === 'board-api')!;
    const view = render(<SessionDetail id={initial.id} latestTurnId={initial.turnId} service={service} hosts={seed.hosts} onClose={vi.fn()} onRead={onRead} stale={false} />);
    expect(await screen.findByRole('heading', { name: initial.title })).toBeInTheDocument();
    service.getSession = vi.fn().mockResolvedValue({ ...initial, turnId: 'next-turn', title: '新的最新任务', prompt: '这是新一轮指令', status: 'running' });
    view.rerender(<SessionDetail id={initial.id} latestTurnId="next-turn" service={service} hosts={seed.hosts} onClose={vi.fn()} onRead={onRead} stale={false} />);
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('这是新一轮指令')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: initial.title })).not.toBeInTheDocument();
    expect(onRead).not.toHaveBeenCalled();
  });
});


describe('Direct subagent details', () => {
  const child = {
    nativeId: 'child', parentThreadId: 'parent', nickname: 'Ada', path: '/root/swe', role: null,
    model: 'actual-model', effort: 'high', modelObservedAt: null, turnId: 'child-turn',
    status: 'completed' as const, startedAt: null, completedAt: null, activityAt: null,
    prompt: 'child request', response: 'child result', reason: null,
    collectedAt: new Date().toISOString(), freshness: 'fresh' as const,
  };
  async function show(collection?: import('../services/generated/board').SubagentCollection) {
    const seed = createSeed();
    const session = seed.sessions[0];
    Object.assign(session, { source: 'codex_cli', storageHostId: 'local', subagents: collection, status: 'unknown' });
    const service = createMockService({ initialState: seed });
    service.markRead = vi.fn();
    render(<SessionDetail id={session.id} service={service} hosts={seed.hosts} onClose={vi.fn()} onRead={vi.fn()} stale={false} />);
    await screen.findByRole('region', { name: '此会话的直接子代理' });
    return service;
  }
  it('shows actual runtime, cross-turn scope and child text without marking it read', async () => {
    const service = await show({ status: 'complete', scannedAt: new Date().toISOString(), items: [child] });
    expect(screen.getByText(/可能跨任务轮次/)).toBeInTheDocument();
    expect(screen.getByText('actual-model')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('child request')).toBeInTheDocument();
    expect(screen.getByText('child result')).toBeInTheDocument();
    expect(screen.getByText('独立采集时间')).toBeInTheDocument();
    expect(service.markRead).not.toHaveBeenCalled();
  });
  it('distinguishes unscanned from confirmed empty', async () => {
    await show();
    expect(screen.getByText('尚未扫描子代理。')).toBeInTheDocument();
    expect(screen.queryByText('本次扫描未发现直接子代理记录。')).not.toBeInTheDocument();
  });
  it.each(['complete', 'partial', 'error'] as const)('explains empty %s scan', async status => {
    await show({ status, scannedAt: new Date().toISOString(), items: [] });
    expect(screen.getByText(status === 'complete' ? '本次扫描未发现直接子代理记录。' : '当前缓存没有可展示的直接子代理，不能确认不存在。')).toBeInTheDocument();
  });
  it('labels stale child samples even when the parent is fresh', async () => {
    await show({ status: 'complete', scannedAt: new Date().toISOString(), items: [{ ...child, freshness: 'stale' }] });
    expect(screen.getByText(/陈旧样本/)).toBeInTheDocument();
  });
});
