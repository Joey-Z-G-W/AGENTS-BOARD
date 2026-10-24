import { buildApp } from './app.js';
import { AuthService } from './auth/service.js';
import { collectOnce } from './collection/once.js';
import { MemoryStore } from './store/memory.js';

async function start() {
  const password = process.env.BOARD_PASSWORD ?? 'admin';
  if (password === 'admin') process.stderr.write('警告：使用默认弱密码 admin，仅限本机预览；可通过 BOARD_PASSWORD 覆盖。\n');
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效。');
  const auth = await AuthService.create(process.env.BOARD_USERNAME ?? 'admin', password);
  const snapshot = process.env.BOARD_DATA_MODE === 'snapshot' ? await collectOnce() : undefined;
  const store = snapshot ? new MemoryStore(Date.now, snapshot.state, { collectedAt: snapshot.collectedAt, warnings: snapshot.warnings }) : undefined;
  if (snapshot) process.stdout.write(JSON.stringify({ collectedAt: snapshot.collectedAt, summary: snapshot.summary }) + '\n');
  const frontendPort = Number(process.env.BOARD_FRONTEND_PORT ?? 5173);
  const app = await buildApp({
    auth,
    store,
    polling: !snapshot,
    allowedOrigins: ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://127.0.0.1:' + frontendPort, 'http://localhost:' + frontendPort],
  });
  await app.listen({ host: '127.0.0.1', port });
  process.stdout.write('Agents Board：http://127.0.0.1:' + port + (snapshot ? '（真实单次快照，仅存内存）' : '（内存演示，无真实采集）') + '\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}

start().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : '启动失败') + '\n');
  process.exitCode = 1;
});
