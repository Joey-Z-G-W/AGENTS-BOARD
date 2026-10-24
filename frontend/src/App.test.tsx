import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { createMockService } from './services/mock';
import { createSeed } from './services/seed';
import { ServiceError } from './services/types';

describe('Dashboard interactions', () => {
  it('runs entirely against the mock, exposes Unknown and excludes stale Running from live counts', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<App service={createMockService()} />);
    await screen.findByRole('region', { name: 'AGENTS-BOARD' });
    const overview = screen.getByRole('region', { name: '工作概览' });
    expect(within(overview).getByRole('button', { name: /正在运行.*02/ })).toBeInTheDocument();
    expect(screen.getByText('上次：正在运行')).toBeInTheDocument();
    expect(screen.getByText('主机离线')).toBeInTheDocument();
    expect(screen.getByText('证据不足 · 需要确认的会话')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks the opened completed task read, renders its response and persists across reloads', async () => {
    const user = userEvent.setup();
    const service = createMockService({ storage: localStorage });
    const view = render(<App service={service} />);
    await user.click(await screen.findByRole('button', { name: '查看 实现项目折叠列表与会话卡片' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('已读')).toBeInTheDocument());
    expect(within(dialog).getByText(/验证结果：组件测试通过，构建通过/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();
    render(<App service={createMockService({ storage: localStorage })} />);
    const card = await screen.findByRole('button', { name: '查看 实现项目折叠列表与会话卡片' });
    expect(within(card).getByText('已读')).toBeInTheDocument();
  });

  it('keeps project expansion state across refresh and supports search with an empty state', async () => {
    const user = userEvent.setup();
    render(<App service={createMockService()} />);
    const project = await screen.findByRole('region', { name: 'AGENTS-BOARD' });
    const toggle = within(project).getByRole('button', { expanded: true });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: '立即刷新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '立即刷新' })).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    await user.type(screen.getByRole('textbox', { name: '搜索项目或会话' }), 'not-found');
    expect(screen.getByText('没有匹配的会话')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('button', { name: '查看 实现项目折叠列表与会话卡片' })).toBeInTheDocument();
  });

  it('filters waiting tasks without hiding the separate unknown filter', async () => {
    const user = userEvent.setup();
    render(<App service={createMockService()} />);
    await screen.findByRole('region', { name: 'AGENTS-BOARD' });
    await user.click(screen.getByRole('button', { name: '等待处理' }));
    expect(screen.getByRole('button', { name: '查看 为采集适配器补充边界测试' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看 整理服务层的数据契约' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '状态未知' }));
    expect(screen.getByRole('button', { name: '查看 定位集成测试中的连接中断' })).toBeInTheDocument();
  });

  it('adds, disables, re-enables and removes remote hosts while protecting localhost', async () => {
    const user = userEvent.setup();
    const service = createMockService();
    render(<App service={service} />);
    await screen.findByRole('region', { name: 'AGENTS-BOARD' });
    await user.click(screen.getByRole('button', { name: /^主机设置/ }));
    await user.click(screen.getByRole('button', { name: 'staging' }));
    expect(screen.getByRole('textbox', { name: 'SSH 别名或地址' })).toHaveValue('staging');
    await user.click(screen.getByRole('button', { name: '添加到监控' }));
    await user.click(await screen.findByRole('button', { name: '暂停 staging' }));
    await user.click(await screen.findByRole('button', { name: '启用 staging' }));
    await user.click(await screen.findByRole('button', { name: '移除 staging' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '暂停 staging' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '移除 本机' })).not.toBeInTheDocument();
    expect((await service.getHosts()).hosts).toHaveLength(3);
  });

  it('offers a retry after initial failure and retains cached data if a later load fails', async () => {
    const user = userEvent.setup();
    const service = createMockService();
    const original = service.getDashboard;
    service.getDashboard = vi.fn().mockRejectedValueOnce(new Error('测试：服务离线')).mockImplementation(original);
    render(<App service={service} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('测试：服务离线');
    await user.click(screen.getByRole('button', { name: '重试连接' }));
    await screen.findByRole('region', { name: 'AGENTS-BOARD' });
    service.getDashboard = vi.fn().mockRejectedValue(new Error('测试：连接中断'));
    await user.click(screen.getByRole('button', { name: '立即刷新' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前显示缓存快照');
    expect(screen.getByRole('region', { name: 'AGENTS-BOARD' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '工作概览' })).getByRole('button', { name: /正在运行.*00/ })).toBeInTheDocument();
  });

  it('shows a read conflict without falsely marking the task read', async () => {
    const user = userEvent.setup();
    const service = createMockService();
    service.markRead = vi.fn().mockRejectedValue(new ServiceError('新任务已开始，请重新打开。', 'CONFLICT'));
    render(<App service={service} />);
    await user.click(await screen.findByRole('button', { name: '查看 实现项目折叠列表与会话卡片' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('新任务已开始');
    expect(within(screen.getByRole('dialog')).getByText('完成 · 未读')).toBeInTheDocument();
  });

  it('renders source content as text, never executable HTML', async () => {
    const user = userEvent.setup();
    const seed = createSeed();
    seed.sessions[1].response = '<img src=x onerror="alert(1)">';
    render(<App service={createMockService({ initialState: seed })} />);
    await user.click(await screen.findByRole('button', { name: '查看 实现项目折叠列表与会话卡片' }));
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
  });

  it('polls every 15 seconds without triggering manual scans and stops on unmount', async () => {
    vi.useFakeTimers();
    const service = createMockService();
    const read = vi.spyOn(service, 'getDashboard');
    const refresh = vi.spyOn(service, 'refresh');
    const view = render(<App service={service} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
