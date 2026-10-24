# Agents Board · Frontend

独立的 React + TypeScript + Vite 前端，默认使用持久化 Mock，无需后端或 SSH 环境。也可登录 `../backend` 的内存演示服务；真实来源 PoC 仅部分通过，不能将种子状态视为真实采集能力验证。

## 运行

在 `frontend` 目录执行：

```sh
npm ci
npm run dev
```

打开终端输出的地址，默认 `http://127.0.0.1:5173`，开发和预览服务仅绑定回环地址。

```sh
npm test
npm run typecheck
npm run build
npm run preview
```

Node.js 22.18+（本批使用 24.19 验证，Orval 不支持旧的 22.3）。提交的 `package-lock.json` 锁定依赖；开发用 Vite，构建结果位于 `dist`。静态部署时使用站点根路径，不需要 SSR。

## 已实现

- 项目折叠列表、五种任务状态、优先级排序、搜索与状态筛选。
- 最近 7 天项目过滤；Read 且完成超过 24 小时隐藏，Unread 不受 24 小时规则影响。
- 最新任务详情，打开已完成的未读任务即标为 Read，操作携带任务标识防止旧任务读掉新任务。
- 离线与过期快照显式展示，缓存状态不计入当前运行、等待和未读计数。
- 15 秒拉取快照、手动刷新、加载失败重试、连接中断保留缓存。
- SSH 候选与主机添加、移除、启停；本机始终保留。
- 中文界面、移动端布局、键盘操作、原生模态详情和纯文本响应渲染。

## 服务层

所有看板后端操作统一通过 `src/services/types.ts` 的 `BoardService` 接口；登录/注销经 `services/auth.ts`。组件和 hooks 不使用 `fetch`、XHR，也不导入生成请求，唯一 HTTP 传输实现位于 `src/services/transport.ts`。

| 文件 | 责任 |
| --- | --- |
| `src/services/types.ts` | 生成 DTO 的类型重导出、必要别名、错误与服务接口 |
| `src/services/mock.ts` | 内存数据操作、模拟快照、时间过滤、已读竞态和本地持久化 |
| `src/services/seed.ts` | 三个项目、三台主机、三个工具来源的脱离真实环境的示例 |
| `src/services/http.ts` | 将生成请求适配为 BoardService，保留 mock 注入边界 |
| `src/services/generated/board.ts` | Orval 生成的 DTO、路径编码和请求函数，不手工编辑 |
| `src/services/transport.ts` | 唯一 fetch 入口：Bearer、超时、调用方取消、204、错误和并发 401 保护 |
| `src/services/index.ts` | 按环境变量选择实现，默认 Mock |
| `src/hooks/useBoard.ts` | 拉取快照、定时更新、过期响应防护、操作忙状态 |

`App` 也接受 `service` 属性，测试直接注入实现。Mock 状态保存在当前 origin 的 `localStorage` 键 `agents-board.mock.v1`；清除该键并重新加载即可恢复示例，存储失败时修改回滚并提示错误。运行中的示例任务不会随机完成，手动刷新仅模拟重新采样，离线示例保持离线；自动采样在读取 Mock 快照时惰性模拟，不会启动真实后台任务。

## 接口生成

唯一契约为 `../_docs/api/openapi.json`，当前为 0.4.0；使用锁定的 Orval 8.44.0 和 `orval.config.ts` 生成，不维护第二份 DTO 或 Query hooks。修改契约后运行 `npm run generate:api`，再运行 `npm run check:generated`、`npm run typecheck` 和 `npm test`；重现检查在比较后恢复原生成文件，不会悄悄接受契约漂移。

生成类型保留 nullable、枚举和新增刷新作业协议；JSON Schema 的条件约束并不等于 TypeScript 运行时校验，服务端仍需按契约验证。新增 `requestSessionRefresh`/`getRefresh` 仅已生成，尚未接入 BoardService、mock 或详情 UI，不表示当前旧后端支持定向采集。现有 mock 新种子补全了证据字段，但旧 localStorage 状态的完整迁移、刷新作业模拟和取消语义留待后续 mock 对齐任务。

Orval 的 `@scalar/json-magic` 传递依赖 `undici` 锁定覆盖为 7.30.1，避免安装时发现的已知漏洞；更新 Orval 时复查该覆盖。既有 Vitest 3/tinypool 的开发依赖审计告警不在本批迁移范围，不应把开发测试服务暴露到公网。

示例刻意包含未读任务用于体验界面，不代表真实首次导入行为；真实后端须将导入前已完成任务初始化为 Read。来源发现、Git 身份解析、真实 SSH 配置读取、后台采集和原生工具已读识别仍由未来后端负责。

## 对接真实后端

将 `.env.example` 复制为 `.env.local`，设置 `VITE_SERVICE_MODE=http` 与 `VITE_API_BASE_URL=/api`，重新启动 Vite。已配置 `/api` 到 `http://127.0.0.1:3001` 的同源开发代理，固定端口 5173。先按 `../backend/README.md` 启动服务，再登录；默认账号/密码为 `admin/admin`，仅限本机预览，可通过启动环境覆盖。不允许跨域通配 CORS。生产静态部署与 preview 尚未配置 API 反向代理。

HTTP 实现不会在请求失败时偷偷退回模拟数据。以下八个接口已由内存后端实现，但不执行真实采集；完整认证契约见 `../_docs/api/openapi.json`。登录/注销使用 `src/services/auth.ts`，与 BoardService 共用生成请求和 `src/services/transport.ts`；令牌仅放页面内存，401/过期/退出后清除，刷新页面需要重新登录。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/dashboard` | — | `Dashboard`：已过滤排序的项目与最新任务快照 |
| GET | `/sessions/:id` | — | `Session` |
| POST | `/sessions/:id/read` | `{ turnId }` | 更新后的 `Session`，旧任务返回 409 |
| GET | `/hosts` | — | `{ hosts, candidates }` |
| POST | `/hosts` | `{ target }` | 新建 `Host` |
| PATCH | `/hosts/:id` | `{ enabled }` | 204 |
| DELETE | `/hosts/:id` | — | 204 |
| POST | `/refresh` | — | 204，后台接受刷新请求，后续快照体现结果 |

错误响应为 `{ message, code }`，日期为 ISO 8601 字符串。后端负责最终状态、来源新鲜度和排序/时间窗口；前端在读取失败时额外将保留快照显示为过期。

## 测试

Vitest + Testing Library 在 jsdom 中测试服务和用户交互，原生 dialog 方法在测试环境中提供轻量替身。覆盖 Mock 隔离与持久化、7 天/24 小时边界、主机生命周期、离线缓存、任务标识竞态、HTTP 契约、详情已读、搜索/折叠/筛选、失败恢复、内容安全和 15 秒轮询清理；真实布局与浏览器行为需配合本地浏览器验收。
