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
