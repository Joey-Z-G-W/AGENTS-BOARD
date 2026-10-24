import { buildApp } from './app.js';
import { AuthService } from './auth/service.js';

async function start() {
  const password = process.env.BOARD_PASSWORD;
  if (!password) throw new Error('必须设置 BOARD_PASSWORD（至少 12 位）；没有默认密码。');
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效。');
  const auth = await AuthService.create(process.env.BOARD_USERNAME ?? 'admin', password);
  const app = await buildApp({
    auth,
    allowedOrigins: ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://127.0.0.1:5173', 'http://localhost:5173'],
  });
  await app.listen({ host: '127.0.0.1', port });
  process.stdout.write('Agents Board 内存演示后端：http://127.0.0.1:' + port + '（无真实采集）\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}

start().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : '启动失败') + '\n');
  process.exitCode = 1;
});
