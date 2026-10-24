# Agents Board

面向编码 Agent 的本地活动看板，按项目聚合会话，帮助你查看哪些任务正在执行、等待操作，以及哪些结果尚未阅读。

目标数据源为 **Codex CLI、Cursor CLI 和 Cursor IDE Agent / Composer**，覆盖本机与通过 SSH 访问的开发主机。

> 当前为开发中的原型：前端默认展示 Mock 数据，TypeScript 后端支持内存演示与显式真实单次采集；Go 后端处于独立迁移阶段，尚未替代现有服务。持续采集和持久化仍未完成，示例状态不代表真实机器上的任务状态。

## 当前能力

| 模块 | 状态 |
| --- | --- |
| React 看板 | 项目折叠、搜索、状态筛选、任务详情、主机设置 |
| 状态展示 | Running、Waiting、Unread、Read、Unknown，独立显示离线与过期标记 |
| 时间规则 | 最近 7 天项目；完成超过 24 小时的已读任务隐藏；每 15 秒刷新 |
| 前端 Mock | 合成示例与 localStorage 持久化，可独立运行 |
| Fastify 后端 | 登录与 Bearer 认证、看板 / 会话 / 主机接口、内存演示存储 |
| Go 后端 | Gin 工程、OpenAPI 生成链与健康检查；业务迁移尚未完成 |
| API 文档 | OpenAPI 契约与来源能力说明 |
| 真实采集 | 已有三机只读单次采集，尚未完成持续运行验证 |

前端 HTTP 服务层已接入 Bearer 登录，并由同一 OpenAPI 生成请求和 DTO；可继续连接现有 TypeScript 后端。新增定向刷新协议目前仅完成契约与生成代码，不能把它当作已实现的持续采集；体验界面也可使用独立 Mock 模式。

Go 迁移的架构选择见 [组件决策](component.md)，执行状态见 [迁移进度](_docs/backend/go-progress.md)，构建与兼容性验证见 [Go 后端说明](backend-go/README.md)。未验收前不要将前端代理改指 Go 健康检查服务。

## 快速开始

需要 Node.js 和 npm；建议使用 Node.js 24。后端的版本范围为 `^22.12.0 || ^24.0.0 || >=26.0.0`，以 `backend/package.json` 为准。前后端是独立 npm 项目，各自维护锁文件；根目录没有 npm workspace。

```sh
git clone https://github.com/JoeyEnjoyLoL/AGENTS-BOARD.git
cd AGENTS-BOARD/frontend
npm ci
npm run dev
```

打开终端显示的地址，默认是 [http://127.0.0.1:5173](http://127.0.0.1:5173)。无需后端、账号或 SSH 配置即可体验示例。

Mock 数据保存于当前站点的 localStorage 键 `agents-board.mock.v1`。清除此键并刷新页面可恢复初始示例。模拟任务不会随机完成，添加主机也不会发起真实 SSH 连接。

## 运行后端演示

在另一个终端进入 `backend` 目录：

```sh
npm ci
```

PowerShell：

```powershell
$env:BOARD_USERNAME = 'admin'
$env:BOARD_PASSWORD = 'replace-with-your-own-long-password'
npm run dev
```

macOS / Linux：

```sh
BOARD_USERNAME=admin BOARD_PASSWORD='replace-with-your-own-long-password' npm run dev
```

默认账号/密码为 `admin/admin`，仅限本机预览；其他自定义密码须为 12–256 位，请替换示例值。服务默认监听 `127.0.0.1:3001`，可通过 `PORT` 修改端口。`.env.example` 说明可用变量，当前启动脚本不会自动加载 `.env`。

- `GET /api/health`：健康状态与演示模式。
- `GET /api/openapi.json`：API 契约。
- `POST /api/auth/login`：提交 JSON `{ "username": "admin", "password": "你的密码" }` 获取 `accessToken`。
- 业务请求使用 `Authorization: Bearer <accessToken>`；`POST /api/auth/logout` 注销当前令牌。

数据、主机设置、已读标记及登录令牌均保存在内存，重启后重置。服务面向本机使用，不应直接暴露到公网。

## 开发与验证

在 `frontend` 或 `backend` 中分别执行：

```sh
npm run typecheck
npm run build
npm test
```

前端使用 Vitest、Testing Library 和 jsdom，覆盖服务层、任务已读、筛选、轮询和错误恢复。测试脚本与覆盖范围以各子项目当前内容为准。

构建产物输出至各自 `dist/`。前端用 `npm run preview` 在本地预览；后端构建后用 `npm start` 启动，仍需设置上述环境变量，并保留 `_docs/api/openapi.json` 的相对位置。

## 项目结构

```text
AGENTS-BOARD/
├── frontend/                 # React + TypeScript + Vite
│   └── src/
│       ├── components/       # 项目、会话详情、主机设置
│       ├── hooks/            # 看板加载与轮询
│       └── services/         # Mock / HTTP 服务接口
├── backend/                  # Fastify + TypeScript
│   └── src/
│       ├── auth/             # 密码校验与令牌
│       ├── models/           # 类型、错误、契约校验
│       ├── routers/          # 认证、看板、主机路由
│       └── store/            # 内存存储与合成样本
└── _docs/
    ├── plan.md               # 产品需求与 MVP 范围
    ├── tasks.md              # 开发任务拆分
    ├── api/                  # OpenAPI 契约与说明
    └── research/             # 可行性报告与脱敏观察摘要
```

## 设计约定与后续工作

- 每个原生会话展示一张卡片，只反映最新一轮任务。
- 无法确认状态时显示 Unknown；离线缓存不能作为任务仍在运行的证据。
- 项目按实际 Agent 活动排序，不能用 Git 提交或文件修改时间替代。
- 目标是只读监控，不负责启动 Agent、发送提示词或代替用户审批。
- 后续按 Go 任务清单完成业务迁移、持续来源适配、状态转换和故障恢复验收；持久化需另行确认，不默认将真实正文落盘。

详细说明见 [前端文档](frontend/README.md)、[产品需求](_docs/plan.md)、[任务列表](_docs/tasks.md)、[API 文档](_docs/api/README.md)和[可行性报告](_docs/research/feasibility.md)。研究与规划文档记录各自日期的结论，不应将其中的计划视为已实现功能。
