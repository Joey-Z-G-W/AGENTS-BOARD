import type { Session, State } from '../models/types.js';

export function createSeed(now: number): State {
  const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const makeSession = (overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session => ({
    turnId: overrides.id + '-turn-1', turnIdentityKind: 'native',
    projectId: 'board-demo', hostId: 'local', storageHostId: 'local',
    source: 'codex_cli', status: 'running', freshness: 'fresh',
    activityAt: ago(1), startedAt: ago(10), completedAt: null, durationSeconds: null,
    directory: '/workspace/demo-board', branch: 'main', worktree: null,
    prompt: '合成指令：验证看板交互。', response: null, reason: '演示数据，不代表实际 Agent 状态。',
    evidence: { level: 'inferred', basis: 'unsupported', observedAt: ago(0), sourceVersion: 'synthetic-seed', reason: '仅用于开发联调。' },
    capabilities: { latestTurn: 'candidate', waiting: 'unavailable', finalResponse: 'candidate', nativeRead: 'unavailable', exactCompletionTime: 'candidate' },
    ...overrides,
  });
  return {
    projects: [
      { id: 'board-demo', name: 'Agents Board · 演示', repository: 'example.invalid/demo/board', identityKind: 'git_remote' },
      { id: 'tools-demo', name: '开发工具 · 演示', repository: null, identityKind: 'host_directory' },
    ],
    hosts: [
      { id: 'local', name: '本机 · 演示', address: 'localhost', local: true, enabled: true, connection: 'online', lastSuccessAt: ago(0), error: null },
      { id: 'demo-dev', name: '开发机 · 演示', address: 'demo-dev', local: false, enabled: true, connection: 'online', lastSuccessAt: ago(0), error: null },
      { id: 'demo-offline', name: '离线主机 · 演示', address: 'demo-offline', local: false, enabled: true, connection: 'offline', lastSuccessAt: ago(60), error: '合成离线样本，未发起 SSH。' },
    ],
    candidates: [{ alias: 'demo-staging', address: 'demo-staging' }],
    sessions: [
      makeSession({ id: 'demo-waiting', title: '等待审批 · 演示', status: 'waiting', source: 'cursor_cli' }),
      makeSession({ id: 'demo-unread', title: '接口测试已完成 · 演示', status: 'unread', activityAt: ago(3), completedAt: ago(3), durationSeconds: 420, response: '合成结果：8 个业务接口可用于联调。' }),
      makeSession({ id: 'demo-running', title: '实现采集适配器 · 演示', hostId: 'demo-dev', storageHostId: 'demo-dev', source: 'cursor_ide' }),
      makeSession({ id: 'demo-read', title: '历史完成任务 · 演示', status: 'read', activityAt: ago(30), startedAt: ago(40), completedAt: ago(30), durationSeconds: 600, response: '合成历史任务，导入为已读。' }),
      makeSession({ id: 'demo-stale', title: '离线运行快照 · 演示', projectId: 'tools-demo', hostId: 'demo-offline', storageHostId: 'demo-offline', freshness: 'stale', activityAt: ago(61) }),
      makeSession({ id: 'demo-unknown', title: '无法解析的最新任务 · 演示', projectId: 'tools-demo', source: 'cursor_cli', status: 'unknown', turnId: null, turnIdentityKind: 'unavailable', hostId: null, directory: null, prompt: null, activityAt: null, startedAt: null, reason: '无法可靠解析最新任务和工作区；这是合成缺失数据样本。' }),
    ],
  };
}
