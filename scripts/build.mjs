import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(root, 'dist', 'board');
export let release = releases;
export let executable = path.join(release, process.platform === 'win32' ? 'board.exe' : 'board');
const manifestPath = path.join(releases, 'manifest.json');
const inputs = ['backend-go/cmd', 'backend-go/internal', 'backend-go/probes', 'backend-go/go.mod', 'backend-go/go.sum',
  'frontend/src', 'frontend/public', 'frontend/index.html', 'frontend/package.json', 'frontend/package-lock.json',
  'frontend/tsconfig.json', 'frontend/vite.config.ts', '_docs/api/openapi.json', 'scripts/build.mjs'];

export async function fingerprint() {
  const hash = createHash('sha256');
  hash.update(process.platform + ':' + process.arch + ':http:/api');
  async function add(relative) {
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'ENOTDIR') throw error;
      hash.update(relative.replaceAll('\\', '/'));
      hash.update(await readFile(path.join(root, relative)));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name !== '__pycache__') await add(path.join(relative, entry.name));
    }
  }
  for (const input of inputs) await add(input);
  return hash.digest('hex');
}

export async function readyBuild() {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!/^build-[0-9a-f-]{36}$/.test(manifest.directory)) return false;
    release = path.join(releases, manifest.directory);
    executable = path.join(release, process.platform === 'win32' ? 'board.exe' : 'board');
    await access(executable);
    await access(path.join(release, 'web', 'index.html'));
    return manifest.fingerprint === await fingerprint() && manifest.mode === 'http';
  } catch { return false; }
}

export function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false, ...options });
    child.once('error', () => reject(new Error(`无法运行 ${path.basename(program)}，请检查安装和 PATH。`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(program)} 执行失败（${code}）。`)));
  });
}

export async function build() {
  const node = process.env.BOARD_NODE || process.execPath;
  if (node !== process.execPath) {
    await command(node, [fileURLToPath(import.meta.url)], { env: { ...process.env, BOARD_NODE: '' } });
    if (!await readyBuild()) throw new Error('构建产物未通过一致性检查。');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('首次构建需要 Node.js >=22.18。升级 Node，或设置 BOARD_NODE 为新版 node.exe 路径；已有有效产物可直接 npm start。');
  const npmCLI = process.env.npm_execpath;
  // npm supplies its JS entry when run through npm run build/start. Direct callers
  // may supply BOARD_NPM_CLI rather than invoking a .cmd through a shell.
  const npmPath = process.env.BOARD_NPM_CLI || npmCLI;
  if (!npmPath) throw new Error('请通过 npm run build / npm start 构建，或配置 BOARD_NPM_CLI 为 npm-cli.js 路径。');
  const frontend = path.join(root, 'frontend');
  const sourceFingerprint = await fingerprint();
  try { await access(path.join(frontend, 'node_modules', '.package-lock.json')); }
  catch {
    console.log('准备前端依赖…');
    await command(node, [npmPath, 'ci', '--no-audit', '--no-fund'], { cwd: frontend });
  }
  console.log('构建 HTTP 模式页面…');
  // Set both variables explicitly so a developer .env cannot produce a mock release.
  await mkdir(releases, { recursive: true });
  if (await realpath(releases) !== releases) throw new Error('构建目录包含链接或重定向，请使用仓库内 dist/board 普通目录。');
  const directory = 'build-' + randomUUID();
  const nextRelease = path.join(releases, directory);
  await mkdir(nextRelease);
  const web = path.join(nextRelease, 'web');
  await command(node, [path.join(frontend, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], { cwd: frontend });
  await command(node, [path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', web], { cwd: frontend, env: { ...process.env, VITE_SERVICE_MODE: 'http', VITE_API_BASE_URL: '/api' } });
  const nextBinary = path.join(nextRelease, process.platform === 'win32' ? 'board.exe' : 'board');
  console.log('构建 Go 服务…');
  await command(process.env.BOARD_GO || 'go', ['build', '-trimpath', '-o', nextBinary, './cmd/board'], { cwd: path.join(root, 'backend-go') });
  if (await fingerprint() !== sourceFingerprint) throw new Error('构建期间源码已改变，请重新构建。');
  // Each version is immutable. Switching this small pointer cannot replace files
  // under a running Go process, and concurrent builds use separate directories.
  const nextManifest = path.join(releases, directory + '.json');
  await writeFile(nextManifest, JSON.stringify({ mode: 'http', directory, fingerprint: sourceFingerprint, builtAt: new Date().toISOString() }, null, 2));
  await rename(nextManifest, manifestPath);
  release = nextRelease;
  executable = nextBinary;
  console.log('构建完成：' + nextRelease);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
