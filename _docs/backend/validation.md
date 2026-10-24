# 实现验证记录

日期：2026-10-24。仅本机开发验证，不连接 T-11257/NB-11257，不修改真实 Agent 数据。

| 检查 | 结果 |
|---|---|
| 后端类型检查/构建 | 通过，TypeScript 严格模式 |
| 后端测试 | 46 通过，3 个文件；Vitest 5.0.5 |
| 前端类型检查/构建 | 通过 |
| 前端测试 | 34 通过，5 个文件；原有 30 项加登录/空值与过期详情回归 |
| OpenAPI | 3.1.1 结构校验通过，API 版本 0.3.0；12 个 operation |
| 实际 HTTP + Vite 代理冒烟 | 页面 200、匿名 401、登录 200、2 项目/6 会话、注销 204、撤销令牌 401 |
| 新增后端依赖 npm audit | 安装修复版本后 0 个已知漏洞（检测时快照，不是长期安全保证） |

## 环境与复现

使用已有 Node 24.19.0；系统 Node 22.3 低于新后端测试工具要求。常规 Node 24 环境可按 backend/README 运行 npm ci、npm test、npm run build。

本机已有运行时路径为：
`C:/Users/Joey/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`

实际验证直接调用该 node，运行后端/前端各自的 node_modules/typescript/bin/tsc、node_modules/vitest/vitest.mjs 与前端 node_modules/vite/bin/vite.js。避免系统 npm.ps1 仍使用旁边的旧 node。依赖安装使用该 node 加 `C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js`。

沙箱执行遇到前端依赖 realpath 的 EPERM，授权后重跑成功；首次安装时旧 Node 导致可选原生组件遗漏，换正确 Node 后安装成功。没有删除既有前端依赖或改动其 lockfile。

HTTP 冒烟使用 buildApp 与 Vite 临时 loopback 监听，完成后关闭服务；没有留下新运行进程。默认 5173 当时已有服务，冒烟自动使用空闲端口，未停止既有服务。未做本轮浏览器像素/布局验收；UI 行为通过 jsdom 测试。

## 不包含的证明

- 不是 Cursor/Codex 真实采集器的通过报告。
- 不证明原生 Waiting/Read、Cursor CLI 图解析、跨主机去重或持续 15 秒 SLA。
- 不提供生产渗透测试、外网部署、持久化或多用户隔离保证。
- 现有前端依赖未在本次进行升级；后端 audit 结果不涵盖整个机器/前端既有依赖。

需求缺口及后续方案见 [data-gaps.md](data-gaps.md)。

