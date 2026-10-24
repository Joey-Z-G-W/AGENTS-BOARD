# Agents Board 后端

新增：可用 `BOARD_DATA_MODE=snapshot` 启动真实单次只读采集预览，内容仅保留在内存；范围、统计与限制见 [真实快照说明](../_docs/backend/real-snapshot.md)。以下默认演示模式不变。

TypeScript + Fastify，独立 backend 工程。实现 OpenAPI 0.3.0 的八个业务操作，新增登录、注销、健康检查、契约下载。按 routers / models / store / auth 拆分；使用**内存存储与合成种子数据**，不执行本机 Agent 文件采集、SSH 或原生数据库操作。

## 运行

需要 Node.js 22.12+（22 系列）、24 LTS，或 >=26；推荐 Node 24。系统 Node 22.3 不满足新版后端测试工具要求。

PowerShell，仓库根目录：

```powershell
cd backend
npm ci
$env:BOARD_USERNAME = 'admin'
$env:BOARD_PASSWORD = 'admin'
npm run dev
```

默认账号/密码为 `admin/admin`，仅适合本机预览；使用默认密码时启动会警告。可通过 BOARD_USERNAME / BOARD_PASSWORD 覆盖，其他自定义密码仍须 12–256 位。密码在应用中仍使用随机 salt + scrypt（N=131072, r=8, p=1）保存摘要，不记录自定义密码或令牌。环境变量本身仍由操作系统管理；停止后可运行 `Remove-Item Env:BOARD_PASSWORD` 清除当前终端变量。

默认只监听 http://127.0.0.1:3001；可用 PORT 更改端口，同时调整前端代理目标。不要改为公开监听：当前是单用户、本机、共享看板，不含多租户授权。

生产式本地运行：

```powershell
npm run build
npm start
```

运行编译产物时需保留仓库中的 `../_docs/api/openapi.json`；它是运行时输入校验源，不可只复制 dist。可选 .env.example 仅说明环境字段，程序不自动加载 .env。

## 联调前端

另开终端，仓库根目录：

```powershell
cd frontend
$env:VITE_SERVICE_MODE = 'http'
$env:VITE_API_BASE_URL = '/api'
npm run dev
```

访问 http://127.0.0.1:5173，输入上述启动账号密码。Vite 已配置 /api → 127.0.0.1:3001 的同源代理；无需 CORS。登录后可以查看两个演示项目、六张会话卡、三台演示主机，覆盖五态、离线和空值。新增主机只保存配置，状态 unknown，不会冒充连接成功。

不设置 VITE_SERVICE_MODE 时前端继续使用原来的独立 mock；HTTP 失败不会自动回退 mock。当前不提供静态前端生产托管；vite preview 不是本项目已配置的 API 代理部署方式。

令牌只放前端页面内存，不写 localStorage/sessionStorage。刷新页面需重新登录；过期或 401 会返回登录界面，注销撤销服务器令牌。所有后端请求仍集中在 frontend/src/services。

## API 与安全

- POST /api/auth/login：JSON {username,password}，返回 {accessToken,tokenType,expiresAt}。
- GET /api/health、GET /api/openapi.json：公开，但仍验证 Host/Origin。
- 其他接口包括看板/详情/主机读取均需 `Authorization: Bearer <token>`。
- POST /api/auth/logout：撤销当前令牌；令牌有效期一小时，服务器只存 SHA-256 摘要，重启全部失效。
- 登录每 IP 每分钟最多 5 次、全局最多 2 个并发 scrypt 校验、最多 128 个有效令牌；其余路由每 IP 每路由分钟 120 次。
- 默认信任 localhost/127.0.0.1 的 3001 和 5173 Origin；拒绝 foreign Origin、cross-site 和非 loopback Host，不允许通配 CORS。命令行无 Origin 请求仍需 Bearer。
- JSON 请求最大 16 KiB，拒绝未知字段和类型强制转换。统一 {code,message} 错误，401 带 WWW-Authenticate。
- 服务不记录请求日志、密码、令牌或会话正文；没有回写原生工具的接口。

密码散列使用 [Node crypto scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)，输入校验使用 [Fastify 的请求生命周期](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)与 Ajv 2020-12。OpenAPI 本身不能代替访问控制；验证发生在服务端。

## 模块

| 目录 | 责任 |
|---|---|
| src/routers | auth、board、hosts 路由与 HTTP 状态 |
| src/models | 领域类型、错误、从 OpenAPI 加载的运行时输入校验 |
| src/store | 内存状态、合成 seed、过滤排序、原子已读、主机配置、演示刷新 |
| src/auth | scrypt 密码校验、随机令牌、过期与撤销 |
| src/app.ts | 工厂、限流、安全钩子、错误统一、15 秒演示刷新计时器 |
| src/server.ts | 环境配置与 loopback 启动/关闭 |
| tests | 密码/令牌、存储边界、Fastify inject 契约与安全测试 |

每个 buildApp 可注入独立 MemoryStore 和 AuthService，测试不监听端口、不连接真实主机。store 返回克隆快照；已读比较与更新同步执行，不能误读新 turnId。停用主机保留 stale 会话；删除只移除该存储主机的会话，其他会话仅解除执行主机引用。

## 测试

```powershell
npm test
npm run typecheck
npm run build
```

测试覆盖全部业务路由的认证、登录注销、过期/撤销、错误输入、限流、Origin/Host 防护、实际响应与 OpenAPI schema 的一致性、7 天/24 小时边界、读取冲突、主机删除/停用、异步刷新合并。定时使用可控时钟，不改变原生 Agent。

## 明确限制

内存存储重启丢失配置/已读/令牌，属于本轮用户指定范围；不会伪称持久化。每 15 秒仅重采样合成在线主机，不随机推进任务或制造真实活动；offline 样本保持离线，新主机保持 unknown。所有快照带演示警告。真实采集门槛仍未通过。

详细字段缺口、替代方案与验证顺序见 [数据需求缺口](../_docs/backend/data-gaps.md)，接口见 [OpenAPI](../_docs/api/openapi.json)。
