import type { Host, Session, SshCandidate } from './types';

export interface MockState {
  version: 1;
  sampledAt: string;
  hosts: Host[];
  candidates: SshCandidate[];
  projects: { id: string; name: string; repository: string }[];
  sessions: Session[];
}

export function createSeed(now = Date.now()): MockState {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const session = (overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session => ({
    turnId: `${overrides.id}-turn-1`, turnIdentityKind: 'native', projectId: 'board', hostId: 'local', storageHostId: overrides.hostId ?? 'local',
    source: 'codex_cli', status: 'running', freshness: 'fresh', activityAt: ago(1),
    startedAt: ago(12), completedAt: null, durationSeconds: null,
    directory: 'C:/Users/Joey/code/AGENTS-BOARD', branch: 'feat/dashboard', worktree: null,
    prompt: '请实现项目看板，并验证相关交互。保持每个原生会话只显示最新任务。',
    evidence: { level: 'observed', basis: 'native_task_event', observedAt: ago(0), sourceVersion: 'synthetic-mock', reason: '仅为合成演示，不代表已验证真实来源能力。' },
    capabilities: { latestTurn: 'verified', waiting: 'verified', finalResponse: 'verified', nativeRead: 'unavailable', exactCompletionTime: 'verified' },
    response: null, reason: null, ...overrides,
  });
  return {
    version: 1,
    sampledAt: ago(0),
    hosts: [
      { id: 'local', name: '本机', address: 'localhost', local: true, enabled: true, connection: 'online', lastSuccessAt: ago(0), error: null },
      { id: 'dev-server', name: 'dev-server', address: 'joey@dev.internal', local: false, enabled: true, connection: 'online', lastSuccessAt: ago(0), error: null },
      { id: 'gpu-lab', name: 'gpu-lab', address: 'joey@gpu.internal', local: false, enabled: true, connection: 'offline', lastSuccessAt: ago(46), error: 'SSH 连接超时。保留最近一次成功采集的数据。' },
    ],
    candidates: [
      { alias: 'dev-server', address: 'joey@dev.internal' },
      { alias: 'gpu-lab', address: 'joey@gpu.internal' },
      { alias: 'staging', address: 'joey@staging.internal' },
    ],
    projects: [
      { id: 'board', name: 'AGENTS-BOARD', repository: 'github.com/joey/agents-board' },
      { id: 'gateway', name: 'api-gateway', repository: 'github.com/joey/api-gateway' },
      { id: 'design', name: 'design-system', repository: 'github.com/joey/design-system' },
    ],
    sessions: [
      session({ id: 'board-approval', title: '为采集适配器补充边界测试', status: 'waiting', source: 'cursor_cli', activityAt: ago(2), reason: '等待你在 Cursor CLI 中确认测试命令的执行权限。', prompt: '为采集适配器补充边界测试，覆盖日志截断、空结果和异常退出。' }),
      session({ id: 'board-ui', title: '实现项目折叠列表与会话卡片', status: 'unread', activityAt: ago(4), startedAt: ago(18), completedAt: ago(4), durationSeconds: 840, prompt: '实现项目优先的可折叠看板，突出等待处理和未读结果，并保留离线主机的数据。', response: '已完成项目列表与会话卡片。\n\n• 项目按最近 Agent 活动排序\n• 会话按等待、未读、运行、已读展示\n• 离线数据带有独立提示\n\n验证结果：组件测试通过，构建通过。' }),
      session({ id: 'board-api', title: '整理服务层的数据契约', hostId: 'dev-server', source: 'codex_cli', activityAt: ago(0.5), directory: '/home/joey/agents-board', branch: 'feat/service-contract', worktree: '/home/joey/worktrees/service-contract' }),
      session({ id: 'gateway-rate', title: '检查限流中间件的并发行为', projectId: 'gateway', hostId: 'dev-server', source: 'cursor_ide', activityAt: ago(3), directory: '/home/joey/api-gateway', branch: 'fix/rate-limit', prompt: '检查限流中间件在并发请求下的行为，并添加回归测试。' }),
      session({ id: 'gateway-cache', title: '分析缓存失效后的重试策略', projectId: 'gateway', hostId: 'gpu-lab', freshness: 'stale', activityAt: ago(49), directory: '/home/joey/api-gateway', branch: 'feat/retry', reason: '主机已离线；这里显示的是最后一次采集到的运行状态。' }),
      session({ id: 'gateway-unknown', title: '定位集成测试中的连接中断', projectId: 'gateway', source: 'cursor_cli', status: 'unknown', activityAt: ago(8), directory: 'C:/Users/Joey/code/api-gateway', branch: 'fix/integration', reason: '进程已退出，但未找到明确的任务完成事件。', prompt: '定位集成测试偶发的连接中断问题。' }),
      session({ id: 'design-tokens', title: '统一组件库的间距与颜色变量', projectId: 'design', source: 'cursor_ide', status: 'unread', activityAt: ago(21), startedAt: ago(30), completedAt: ago(21), durationSeconds: 540, directory: 'C:/Users/Joey/code/design-system', branch: 'refactor/tokens', prompt: '统一组件库中的间距与颜色变量，并保持现有组件的视觉效果。', response: '已将重复样式整理为共享变量，并更新组件引用。\n\n验证结果：类型检查与组件测试通过。' }),
      session({ id: 'design-docs', title: '补充 Button 的无障碍使用示例', projectId: 'design', status: 'read', activityAt: ago(62), startedAt: ago(70), completedAt: ago(62), durationSeconds: 480, directory: 'C:/Users/Joey/code/design-system', branch: 'docs/button', response: '已补充键盘操作、焦点样式和图标按钮的可访问名称示例。' }),
    ],
  };
}
