import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { build, executable, readyBuild, release } from './build.mjs';

export function options(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, port: { type: 'string', default: '3003' },
    mode: { type: 'string', default: 'continuous' }, hosts: { type: 'string', default: '' },
    python: { type: 'string', default: 'python' }, 'no-local': { type: 'boolean' },
    'no-open': { type: 'boolean' }, build: { type: 'boolean' }, diagnostics: { type: 'boolean' },
  } });
  if (positionals.length || !/^\d+$/.test(values.port) || +values.port < 1 || +values.port > 65535) throw new Error('参数或端口无效；使用 node scripts/board.mjs --help 查看用法。');
  if (!['demo', 'snapshot', 'continuous'].includes(values.mode)) throw new Error('mode 必须是 demo、snapshot 或 continuous。');
  if (values.mode !== 'demo' && values['no-local'] && !values.hosts.trim()) throw new Error('--no-local 需要同时指定 --hosts。');
  return values;
}

export function available(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`端口 ${port} 不可用。请停止你之前启动的看板，或使用 --port 选择其他端口。`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

function browser(url) {
  const win = process.platform === 'win32';
  const program = win ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = win ? ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${url}'`] : [url];
  const child = spawn(program, args, { windowsHide: true, stdio: 'ignore', shell: false });
  child.once('error', () => console.log(`浏览器未能自动打开，请访问 ${url}`));
  child.once('exit', code => { if (code) console.log(`浏览器未能自动打开，请访问 ${url}`); });
  child.unref();
}

export async function start(values) {
  const port = Number(values.port);
  await available(port);
  if (values.build || !await readyBuild()) await build();
  const url = `http://127.0.0.1:${port}`;
  const args = ['--port', String(port), '--mode', values.mode, '--web-dir', path.join(release, 'web'), '--python', values.python, '--control-stdin'];
  if (values.hosts) args.push('--hosts', values.hosts);
  if (values['no-local']) args.push('--local=false');
  if (values.diagnostics) args.push('--diagnostics');
  const child = spawn(executable, args, { cwd: release, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, shell: false });
  let exited = false, stopping = false, announced = false, spawnError = false;
  const done = new Promise(resolve => {
    child.once('error', () => { spawnError = true; exited = true; resolve(1); });
    child.once('exit', code => { exited = true; resolve(code ?? 1); });
  });
  child.stdin.on('error', () => {});
  let pending = '';
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    pending = (pending + chunk.toString()).slice(-8192);
    if (pending.includes(`Agents Board ready ${url} mode=`)) announced = true;
  });
  let force;
  const stop = () => {
    if (stopping || exited) return;
    stopping = true;
    console.log('\n正在停止本次看板服务…');
    child.stdin.end('stop\n');
    force = setTimeout(() => { if (!exited) child.kill(); }, 12_000);
    force.unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', line => { if (line.trim() === 'stop') stop(); });
  input.on('close', stop);
  const parentExit = () => { if (!exited) child.stdin.destroy(); };
  process.on('exit', parentExit);
  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (!exited && !stopping && Date.now() < deadline) {
      if (announced) {
        try {
          const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
          const health = await response.json();
          const modes = { continuous: 'continuous', demo: 'in-memory-demo', snapshot: 'real-snapshot' };
          const page = await fetch(url, { signal: AbortSignal.timeout(1000) });
          healthy = response.ok && health.status === 'ok' && health.mode === modes[values.mode] && page.ok && (await page.text()).includes('id="root"');
          if (healthy) break;
        } catch { /* readiness is bounded and never substitutes another data mode */ }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (stopping) return await done;
    if (!healthy || exited) throw new Error(spawnError ? 'Go 服务无法启动，请重新构建并检查权限。' : '服务启动失败或未就绪，请查看上方错误。');
    const behavior = values.mode === 'continuous' ? '关闭网页后继续采集' : values.mode === 'snapshot' ? '只采集一次，之后显示缓存' : '仅显示合成示例';
    console.log(`看板已就绪：${url}\n模式：${values.mode}，${behavior}；在此终端按 Ctrl+C 或输入 stop 停止。`);
    if (!values['no-open']) browser(url);
    const code = await done;
    if (code !== 0 && !stopping) throw new Error(`Go 服务异常退出（${code}）。`);
    return code;
  } finally {
    stop();
    await done;
    clearTimeout(force);
    input.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('exit', parentExit);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const values = options(process.argv.slice(2));
    if (values.help) console.log(`用法：node scripts/board.mjs [参数]（Windows也可用 npm.cmd start -- [参数]）\n  --mode continuous|snapshot|demo  默认 continuous\n  --hosts alias1,alias2             额外 SSH 目标，使用系统配置\n  --no-local                       仅采集指定远端\n  --port 3003                      本机端口\n  --python python                  本机 Python 路径\n  --no-open                        不自动打开浏览器\n  --build                          强制重新构建\n  --diagnostics                    仅记录采集计数\n首次构建需要 Go 1.26、Node >=22.18；日常启动使用 dist/board。\n真实采集需要来源机器已有 Python，远端连接需要系统 OpenSSH。\n账号由 BOARD_USERNAME/BOARD_PASSWORD 环境变量配置，默认 admin/admin。`);
    else process.exitCode = await start(values);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
