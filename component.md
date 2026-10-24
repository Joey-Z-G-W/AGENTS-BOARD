# 组件与架构决策

日期：2026-10-24。实施清单见 `_docs/tasks02_go_backend.md`；此文件记录采用的方向，不代表所有能力已经实现。

## 原则

- 优先复用成熟组件，减少人工维护的代码，而非缩短生成产物或删减测试。
- `_docs/api/openapi.json` 是唯一 HTTP 契约来源；Go/TypeScript 的传输类型与接口绑定生成，不重复手写、不手改生成文件。
- `backend-go/` 与现有 `backend/` 并存，未验收前不切换当前服务。默认单用户、loopback、内存存储，不增加远端常驻软件。

## 组件边界

| 范围 | 选择 | 自行实现的边界 |
|---|---|---|
| Go HTTP | Gin + oapi-codegen + 经本契约验证的 OpenAPI 校验中间件 | 业务 handler、错误适配、本地安全策略 |
| 密码 | golang.org/x/crypto/scrypt + crypto/rand + crypto/subtle | 输入约束、摘要编码、有界并发；后续服务必须复用同一个 Passwords 实例 |
| 令牌 | 随机不透明 Bearer，服务端仅保留摘要 | 过期、撤销、容量限制；本批次不声称已迁移 |
| 前端 API | Orval 生成请求/DTO，统一 services transport | Bearer、超时、取消、空响应、错误转换、薄 BoardService 适配 |
| 前端状态 | TanStack Query，后续批次接入 | queryKey、刷新失效、已读时序、认证缓存清理 |
| UI | 现有 React/Vite + 按需 Ant Design，后续批次接入 | 项目卡片与采集语义，不更换为 CRUD 管理后台 |
| Mock | 保留现有 BoardService mock | 有状态合成场景；MSW 仅在能替代重复实现时另行引入 |
| 采集 | Go 调度 + 系统 OpenSSH + 复用 Python 只读探针 | 来源解析、增量游标、状态证据、主机隔离；不执行用户传入命令 |
| 存储 | 内存 | 轮次/采集版本的原子提交；SQLite 必须另行确认 |

## 运行与验证

固定实际可用的依赖版本与生成命令；特别验证 OpenAPI 3.1.1 的 nullable、required、额外属性、日期、错误结构以及安全声明，不以生成成功代替校验。库存在不兼容时公开记录阻塞，不静默降级规范或编写通用替代框架。

密码延续现有 scrypt 参数 N=131072、r=8、p=1、16 字节随机 salt、64 字节摘要；同一服务共享最多两次并行计算。scrypt 调用开始后不能抢占取消，因此取消后仍需等待当前计算结束才能释放名额，避免产生无限制后台计算；HTTP 登录限流和令牌接口是后续集成工作。

密码长度按 OpenAPI/JSON Schema 的 Unicode 码点语义处理；旧 TypeScript 的启动校验使用 UTF-16 length，含补充平面字符的边界密码可能不同，迁移时应明确提示而非静默改变密码。摘要算法与 UTF-8 输入保持一致，已有 Node 合成摘要由 Go 兼容测试验证。

持续模式是目标而非当前快照的实际行为：后台服务在宿主机运行期间独立采集，打开会话额外触发真实定向刷新。重新获取缓存、采集成功和任务已完成是三个不同概念，不能通过修改时间戳冒充实时数据。

本批次只做本地开发与合成测试，不重新连接设备，不写入真实会话正文，不启动自动运行任务。进度与实测命令见 `_docs/backend/go-progress.md`。
