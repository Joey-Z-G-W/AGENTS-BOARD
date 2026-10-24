# Agents Board · Frontend

独立的 React + TypeScript + Vite 前端，默认使用持久化 Mock，无需后端或 SSH 环境。界面与模拟规则遵循 `../_docs/plan.md`；根据本次要求先完成前端，真实数据源 PoC 尚未执行，不能将示例状态视为来源能力验证。

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

Node.js 22.3+ 或受当前依赖支持的较新 LTS 版本。提交的 `package-lock.json` 锁定依赖；开发用 Vite，构建结果位于 `dist`。静态部署时使用站点根路径，不需要 SSR。

## 已实现

- 项目折叠列表、五种任务状态、优先级排序、搜索与状态筛选。
- 最近 7 天项目过滤；Read 且完成超过 24 小时隐藏，Unread 不受 24 小时规则影响。
- 最新任务详情，打开已完成的未读任务即标为 Read，操作携带任务标识防止旧任务读掉新任务。
- 离线与过期快照显式展示，缓存状态不计入当前运行、等待和未读计数。
- 15 秒拉取快照、手动刷新、加载失败重试、连接中断保留缓存。
- SSH 候选与主机添加、移除、启停；本机始终保留。
- 中文界面、移动端布局、键盘操作、原生模态详情和纯文本响应渲染。

## 服务层

所有后端操作统一通过 `src/services/types.ts` 的 `BoardService` 接口。组件和 hooks 不使用 `fetch`、XHR 或直接访问浏览器持久化，唯一 HTTP 传输实现位于 `src/services/http.ts`。

| 文件 | 责任 |
| --- | --- |
| `src/services/types.ts` | 会话、项目、主机、错误与服务接口 |
| `src/services/mock.ts` | 内存数据操作、模拟快照、时间过滤、已读竞态和本地持久化 |
| `src/services/seed.ts` | 三个项目、三台主机、三个工具来源的脱离真实环境的示例 |
| `src/services/http.ts` | 所有 HTTP 请求、路径编码、超时、错误统一处理 |
| `src/services/index.ts` | 按环境变量选择实现，默认 Mock |
| `src/hooks/useBoard.ts` | 拉取快照、定时更新、过期响应防护、操作忙状态 |

`App` 也接受 `service` 属性，测试直接注入实现。Mock 状态保存在当前 origin 的 `localStorage` 键 `agents-board.mock.v1`；清除该键并重新加载即可恢复示例，存储失败时修改回滚并提示错误。运行中的示例任务不会随机完成，手动刷新仅模拟重新采样，离线示例保持离线；自动采样在读取 Mock 快照时惰性模拟，不会启动真实后台任务。

示例刻意包含未读任务用于体验界面，不代表真实首次导入行为；真实后端须将导入前已完成任务初始化为 Read。来源发现、Git 身份解析、真实 SSH 配置读取、后台采集和原生工具已读识别仍由未来后端负责。

## 对接真实后端

将 `.env.example` 复制为 `.env.local`，设置 `VITE_SERVICE_MODE=http` 与 `VITE_API_BASE_URL`，重新启动 Vite。默认相对 `/api`；开发期间可由本地反向代理提供同源 API，或设置明确的本地后端 URL 并由后端允许该开发 origin。

HTTP 实现不会在请求失败时偷偷退回模拟数据。以下接口是本前端提出的对接契约，尚未声称现有后端已实现：

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
