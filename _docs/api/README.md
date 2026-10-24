# Agents Board API

**契约版本：0.4.0 · OpenAPI 3.1.1 · 2026-10-24**

[openapi.json](openapi.json) 是机器可读的唯一 HTTP 契约。TypeScript backend 已实现八个业务接口及认证扩展，并支持显式真实单次快照；持续监控尚未实现，真实结果见 [单次采集说明](../backend/real-snapshot.md)。0.4.0 新增的 continuous 模式、定向刷新作业与采集版本是迁移协议，不表示当前服务已支持；详细字段与兼容边界见 [Go 迁移契约](../backend/go-contract.md)，原有端点说明仍适用于 TypeScript 后端。

## 1. 启动与导入

运行方法见 [backend/README](../../backend/README.md)。默认 API 为 http://127.0.0.1:3001/api，前端通过 Vite 的 /api 同源代理访问。生产静态托管/CORS 尚未配置，不要直接把前端 API 地址换成跨域地址。

将 openapi.json 导入支持 OpenAPI 3.1 的工具；所有示例为合成内容。运行时 GET /api/openapi.json 返回同一文档。编译后端时必须保留契约文件，输入校验会读取其中的 JSON Schema。

## 2. 操作目录

路径相对于 /api；除明确公开项外均要求 Bearer。

| 方法 | 路径 | 输入 | 成功 |
|---|---|---|---|
| POST | /auth/login（公开） | {username,password} | 200 TokenResponse |
| POST | /auth/logout | 无 | 204，撤销当前令牌 |
| GET | /health（公开） | 无 | 200 {status,mode} |
| GET | /openapi.json（公开） | 无 | 200 OpenAPI |
| GET | /dashboard | 无 | 200 Dashboard |
| GET | /sessions/{id} | 无 | 200 Session |
| POST | /sessions/{id}/read | {turnId} | 200 Session |
| GET | /hosts | 无 | 200 HostSettings |
| POST | /hosts | {target} | 201 Host |
| PATCH | /hosts/{id} | {enabled} | 204 |
| DELETE | /hosts/{id} | 无 | 204 |
| POST | /refresh | 无 | 204，仅入队/合并 |

204 无正文。GET 不隐式已读。输入类型严格校验，不把字符串 false 转换为 boolean；额外字段拒绝。详细参数、operationId、状态码、空值与示例以 OpenAPI 为准。

## 3. 认证与错误

默认账号/密码为 admin/admin，仅限本机预览，可通过启动环境覆盖；不提供公开注册。随机 salt 的 scrypt 保存密码摘要；随机不透明 Bearer 令牌默认一小时有效，仅在服务端保留 SHA-256 摘要，注销撤销，重启清空。所有看板数据属于单用户共享工作区，尚无多租户授权。

错误结构为 {code,message}：400 无效输入；401 缺失/失效令牌或登录错误；403 Host/Origin 拒绝；404 不存在；409 业务冲突；413 超过 16 KiB；415 非 JSON 请求体；429 限流；500 内部错误。503 仍保留为未来本地存储不可用的契约错误，当前内存模式没有外部存储依赖。

401 响应带 WWW-Authenticate: Bearer；响应均 no-store。非本机 Host、foreign Origin、cross-site 请求拒绝；无通配 CORS。单台演示主机离线仍为 200 + warning，不令整个看板返回 503。

## 4. 状态、时间与身份

- 每个原生会话一张卡，只取最新任务；稳定 turnId 可为原生或经验证的派生身份，不可得时 null。
- read 原子比较最新 turnId；仅 fresh 且 read/unread 可写。同一轮重复请求幂等。TURN_CHANGED、TURN_ID_UNAVAILABLE、NOT_COMPLETED、SNAPSHOT_STALE 均为 409；失败后不得自动标记新轮。
- 应用阅读标记不写入原生工具；真实 nativeRead 能力未验证时 Web-only。
- status 与 freshness 分离；stale Running 仅是历史快照，不计为当前已确认运行。中断/失败不视为成功 Unread。
- activityAt 只代表 Agent 执行活动；completedAt 只代表成功任务完成时间；未知 null，不用 mtime/recency/Web 点击代替。
- 项目按最近可靠活动滚动 7 天过滤；Read 且已证实完成超过 24h 隐藏。未知活动时间保守保留并警告；未知完成时间不执行精确 24h 隐藏。这是草案已有的降级策略，真实采集上线前仍需产品确认。
- storageHostId 是记录存储/采集主机；hostId 是执行工作区主机，可 null。freshness 基于存储主机。
- 停用保留 stale 缓存；删除只移除该存储主机拥有的会话和标记，其他会话仅解除执行主机引用。无会话项目不显示。
- Git 身份仅在可靠证据下归并；非 Git 用主机限定目录，不能把同名项目直接合并。

## 5. 演示刷新与种子

每 15 秒仅刷新合成在线主机的采样时间，不随机推进任务，不把采样时间写成 Agent activity。手动刷新合并尚未执行的刷新，204 仅表示接受，不能推断采集成功。新添加主机保持 unknown，lastSuccessAt=null；离线种子保持离线。真实 SSH、增量采集、跨主机隔离仍未实现。

sampledAt 是聚合生成时间；lastSuccessAt 是对应主机采样成功时间。即使采样时间很新，合成状态也不构成真实执行证据。Dashboard.warnings 始终包含演示提示。

初始 seed 的 Read 代表历史导入，Unread 代表跟踪之后完成，用于交互体验；这不是实现了真实“首次成功导入”算法。重启所有修改与令牌丢失，符合本轮指定内存存储范围。

## 6. 前端与契约差异

已接入登录/注销及 Bearer、空值显示、未知连接、warning、存储/执行主机区分。缺失轮次或 stale 不会触发自动 read；401 返回登录页。HTTP 不自动回退 mock。

后端提供 evidence/capabilities/identityKind；前端暂不提供完整逐字段能力面板，仅通过 reason、warning、null 表达限制。Mock 仍兼容独立无后端体验，其历史错误码/停用模拟规则不当作真实 HTTP 契约。

真实字段缺口、替代策略和优先顺序详见 [数据需求缺口](../backend/data-gaps.md)。静态样本、官方协议与实际行为验证不能互相替代。

## 7. 验证

- 后端 Fastify inject 测试覆盖认证、业务路由、输入校验、时间规则和响应 schema；密码/令牌与存储另有独立测试。
- 前端测试覆盖登录、Bearer 传递、401 清理和原有交互回归；类型检查与构建独立执行。
- 可在独立 Python 环境执行 `python -m openapi_spec_validator _docs/api/openapi.json` 检查文档结构。
- 验证通过不意味着真实 Agent/SSH 采集门槛通过，也不证明生产安全、持久化或真实 15 秒刷新 SLA。

历史草案 0.2.0 的无认证声明已由 0.3.0 替代；旧客户端必须登录。来源研究记录保留历史日期，不将演示后端实现回填为采集验证成功。

