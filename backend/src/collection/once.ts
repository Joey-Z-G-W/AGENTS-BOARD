import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateModel } from '../models/contract.js';
import type { Session, State, Warning } from '../models/types.js';

const targets = ['local', 't-11257', 'nb-11257'] as const;
type RawSession = Omit<Session, 'id' | 'projectId' | 'hostId' | 'storageHostId'> & {
  nativeId: string; workspaceHost: string | null; commonDir: string | null;
};
export interface ProbeResult {
  observedAt: string;
  sessions: RawSession[];
  diagnostics: Record<string, number>;
}
export interface CollectionResult {
  state: State;
  warnings: Warning[];
  summary: { host: string; connection: string; sessions: number; sources: Record<string, number>; fields: Record<string, number>; diagnostics: Record<string, number> }[];
  collectedAt: string;
}

export function runProbe(command: string, argumentsList: string[], script: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error('只读采集失败、超时或输出超限。'));
    };
    const timer = setTimeout(fail, 90000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return fail();
      chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail();
      settled = true;
      clearTimeout(timer);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProbeResult;
        if (!Array.isArray(value.sessions) || !Number.isFinite(Date.parse(value.observedAt))) throw new Error();
        resolve(value);
      } catch { reject(new Error('采集输出不是有效快照。')); }
    });
    child.stdin.end(script);
  });
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function normalizeProbe(host: string, probe: ProbeResult, state: State): number {
  let rejected = 0;
  for (const raw of probe.sessions) {
    const { nativeId, workspaceHost, commonDir, ...fields } = raw;
    const hostId = workspaceHost ? (targets.includes(workspaceHost as typeof targets[number]) ? workspaceHost : null) : fields.directory ? host : null;
    const id = hash(host + ':' + fields.source + ':' + nativeId);
    const location = commonDir ?? fields.directory;
    const projectId = hash((hostId ?? host + ':unresolved') + ':' + (location ?? id));
    const session: Session = { ...fields, title: fields.title.slice(0, 160), id, projectId, hostId, storageHostId: host };
    if (!validateModel('Session', session)) { rejected++; continue; }
    state.sessions.push(session);
    if (!state.projects.some(project => project.id === projectId)) {
      const name = fields.directory?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '工作区未解析';
      state.projects.push({ id: projectId, name, repository: null, identityKind: commonDir ? 'git_common_dir' : fields.directory ? 'host_directory' : 'unresolved' });
    }
  }
  return rejected;
}

export async function collectOnce(python = process.env.BOARD_PYTHON ?? 'python') : Promise<CollectionResult> {
  const script = await readFile(new URL('../../src/collection/probe.py', import.meta.url), 'utf8');
  const state: State = { projects: [], sessions: [], hosts: [], candidates: [] };
  const warnings: Warning[] = [{
    code: 'PARTIAL_COLLECTION', hostId: null, source: null,
    message: '真实单次采集预览：仅存内存，不含示例；展示本次选中的历史记录，暂不应用 7 天/24 小时隐藏。不是实时监控；刷新不重新采集。',
  }];
  const summary: CollectionResult['summary'] = [];
  for (const host of targets) {
    try {
      const probe = host === 'local'
        ? await runProbe(python, ['-B', '-'], script)
        : await runProbe('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', host, 'python3', '-B', '-'], script);
      const rejected = normalizeProbe(host, probe, state);
      state.hosts.push({ id: host, name: host === 'local' ? '本机（真实快照）' : host, address: host === 'local' ? 'localhost' : host, local: host === 'local', enabled: true, connection: 'online', lastSuccessAt: probe.observedAt, error: null });
      const sessions = state.sessions.filter(session => session.storageHostId === host);
      const sources: Record<string, number> = {};
      const fields: Record<string, number> = {};
      for (const session of sessions) {
        sources[session.source] = (sources[session.source] ?? 0) + 1;
        for (const field of ['turnId', 'prompt', 'response', 'directory', 'completedAt', 'durationSeconds', 'branch'] as const) {
          fields[field] = (fields[field] ?? 0) + (session[field] !== null ? 1 : 0);
        }
      }
      summary.push({ host, connection: 'online', sessions: sessions.length, sources, fields, diagnostics: { ...probe.diagnostics, rejected } });
      warnings.push({ code: 'PARTIAL_COLLECTION', hostId: host, source: null, message: host + '：载入 ' + sessions.length + ' 个真实会话；每来源最多取最近 15 个，非完整历史。跳过 Desktop/子代理；查询失败 ' + probe.diagnostics.errors + '，契约拒收 ' + rejected + '。' });
    } catch {
      state.hosts.push({ id: host, name: host, address: host === 'local' ? 'localhost' : host, local: host === 'local', enabled: true, connection: 'offline', lastSuccessAt: null, error: '只读采集失败或超时；未使用示例数据替代。' });
      summary.push({ host, connection: 'offline', sessions: 0, sources: {}, fields: {}, diagnostics: {} });
    }
  }
  return { state, warnings, summary, collectedAt: new Date().toISOString() };
}
