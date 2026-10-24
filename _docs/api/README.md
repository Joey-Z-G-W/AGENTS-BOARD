# Agents Board API 契约草案

**版本：0.2.0-draft · OpenAPI 3.1.1 · 2026-10-22**

[openapi.json](openapi.json) 是可导入 OpenAPI 工具的正式结构文档，**不是已上线接口或已验证的后端实现**。[可行性报告](../research/feasibility.md)说明真实能力边界，[脱敏证据](../research/evidence.json)保留观察依据。现有前端仍使用原服务接口和 mock，本轮未改应用代码。

## 1. 使用方式

将 openapi.json 导入支持 OpenAPI 3.1 的本地 Swagger UI / Redoc 或 API 客户端。server 为相对路径 /api，必须由本机同源服务提供；不要把文档托管地址误当真实 API，也不要向公共文档服务上传真实会话数据。所有示例都是合成内容。

本契约沿用 frontend/src/services/http.ts 的 8 个操作，但**不完全兼容** frontend/src/services/types.ts：空值与来源信息需要显式适配，不能直接用类型断言假定可用。

## 2. 接口目录

| 方法 | 路径（相对于 /api） | 请求体 | 成功响应 |
|---|---|---|---|
| GET | /dashboard | 无 | 200 Dashboard |
| GET | /sessions/{id} | 无 | 200 Session |
| POST | /sessions/{id}/read | {turnId} | 200 Session |
| GET | /hosts | 无 | 200 HostSettings |
| POST | /hosts | {target} | 201 Host |
| PATCH | /hosts/{id} | {enabled} | 204，无正文 |
| DELETE | /hosts/{id} | 无 | 204，无正文 |
| POST | /refresh | 无 | 204，无正文；只表示入队/合并 |

GET 不隐式改变阅读状态；前端打开完成卡片后再调用 read。所有 JSON 错误采用 {code,message}；详细 schema、operationId、参数与示例以 openapi.json 为准。不新增全历史/原生会话操作接口。

## 3. 核心语义

### 最新轮与已读

- 每个原生会话一张卡，只展示最新任务。会话 ID 由存储来源命名空间及原生身份稳定构造，不能仅靠目录、标题或最新修改时间。
- turnId 为原生 ID，或经证实稳定的用户轮锚点派生 ID；不能确定时为 null，turnIdentityKind=unavailable。
- 首次采集的已完成历史导入 Read；已经跟踪的任务随后完成进入 Unread。旧开始记录没有足够当前证据时不当作仍在运行。
- read 只接受 fresh 且 read/unread 的最新轮；幂等地写应用标记。未知 turnId、轮次变化、尚未成功完成、样本过期分别返回 409。
- 原生 read 属于独立能力；候选字段未经行为验证不能替代 Web 阅读。标记不写入 Cursor/Codex 原生存储。
- 取消/失败/中断不当成成功完成，冻结五态下显示 Unknown 加原因。若未来需要独立终止状态，须修改产品约定，而非私加枚举。

### 时间与新鲜度

- activityAt 只能是实际 Agent 活动；completedAt 只能是最新任务成功完成时间；缺证据均为 null。
- sampledAt 是聚合快照生成时间，不是全体主机扫描完成证明。主机 lastSuccessAt 才反映该主机成功扫描。
- freshness 由**存储主机**采集时效决定；执行工作区主机连接状态单独展示。fresh 也不意味着可据此确认 Running。
- 离线/停用保留旧状态但设 stale，并给原因；旧 Running 不计为“确认正在运行”。
- 定时每主机 15 秒尝试一次，单主机不重叠；手动刷新合并已有扫描，不无限排队。204 不承诺采集完成，前端继续轮询。
- 项目按实际活动滚动 7 天过滤；Read 且已证实完成超过 24 小时才隐藏。不用 read 时间重置隐藏窗口。
- **待产品确认的降级策略**：缺少可靠 activityAt 的未解析记录保留在 unknown/警告区，而非猜测时间后隐藏；未知 completedAt 不执行精确 24 小时隐藏。此草案采用保守显示，并未改变已知时间记录的冻结规则。

### 来源与项目归属

- storageHostId：原生记录存储和采集位置；hostId：执行工作区位置，可能未知。Remote SSH 会话两者可以不同。
- 未验证来源不能标成 codex_cli；Desktop、子代理不默认纳入 MVP，不能用 originator=codex-tui 单字段覆盖 source=vscode。
- 有可靠 origin 才跨主机归并；同机通过 git-common-dir 合并 worktree；无 Git 使用主机限定目录。无法关联时保留明确 unresolved，不用同名目录猜测。
- 相同原生会话若在多处出现，必须证明共享来源命名空间才能去重；本轮未验证镜像副本关系。
- 删除主机仅移除应用配置、该存储主机缓存及其阅读标记。执行位置落在该主机但存储在别处的记录不连带删除；hostId 应重算/解除关联。其他项目聚合需重算。

### 能力与证据

capabilities 的 verified/candidate/unavailable 是**适配器版本验收结果**，不是“字段存在就 verified”。evidence.level=observed 只说明观察到该依据，不能跨越语义验证。例如 observed composer status 不代表成功完成语义已经获证。

Session.response 只接受确认的最终回复，不用最后一个 assistant、思考文本或工具输出填充；无法确认返回 null。API 不输出原始数据库行、全量日志或隐藏思考。

## 4. 与当前前端的差异

| 字段/行为 | 现有前端 | 草案 | 后续适配 |
|---|---|---|---|
| Session.turnId | string | string/null | 未知时禁用 markRead，不能发送空字符串 |
| Session.hostId | string | string/null | 显示未解析执行主机；使用 storageHostId 展示采集故障 |
| Session.directory、prompt、activityAt | string | string/null | 提供明确未知占位；禁止对 null 做时间/文本运算 |
| Session.storageHostId、turnIdentityKind、evidence、capabilities | 无 | 必填新增 | 读取真实能力与缺失原因 |
| Project.repository、activityAt | string | string/null | 非 Git/时间未知的显示与排序 |
| Project.identityKind | 无 | 必填新增 | 展示归并依据/歧义 |
| Host.connection | online/offline | 加 unknown | 新增目标尚未扫描时不能伪报离线或在线 |
| Dashboard.warnings | 无 | 必填数组 | 部分采集/不支持来源需显式展示 |
| read 冲突 | 通用 ServiceError | 明确 409 code | 重新读取详情，不自动 markRead 新轮 |
| refresh | Promise<void> | 204 异步语义 | 不把按钮请求成功当全部扫描成功 |

现有 status/source/freshness 枚举及八个路由保持不变。不得通过伪造值来维持旧 TypeScript 类型；真实后端落地时同步更新服务层类型、mock 和测试，**本轮未执行**。

## 5. 错误与安全约束

- 400：无效输入；404：会话/主机不存在；409：轮次冲突、不能已读、重复主机、本地主机受保护。
- 403：Host/Origin 不符合本地策略；500：内部错误；503：应用本地存储/聚合不可用。单台 SSH 失败仍返回 200 缓存与 warning，不把整个 Dashboard 变成 503。
- 默认只监听 loopback。OpenAPI security=[] 表示草案未定义登录机制，不代表“任何网页都可调用”。必须校验 Host/Origin，拒绝跨站写请求，无通配 CORS；JSON 写入要求 application/json。
- 未实现跨域/外网部署，不应直接开放 0.0.0.0。若未来开放非本机访问，需单独设计认证、授权与 CSRF 防护。
- SSH 目标使用参数数组，严格校验且不能拼接 shell；禁止注入 SSH 选项/任意代理命令。仅复用可信本机 SSH 配置，继续主机密钥校验，不保存密码/私钥。
- 列表、错误、日志均避免泄露凭据。会话本身有敏感内容，因此本地服务安全边界是实现验收项，当前并未实现或安全测试。

## 6. 数据证据追踪

| API 字段/行为 | 观察依据 | 仍需证明 |
|---|---|---|
| Codex turnId、startedAt、completedAt、durationSeconds | E05 原生事件字段 | 实时增量、轮次归并、版本升级兼容 |
| response | E05 last_agent_message；E03 IDE 候选 | IDE final 语义；Cursor CLI 图遍历 |
| storageHostId / hostId | E04 工作区映射 | 未匹配记录、镜像去重 |
| 项目 worktree 身份 | E06 三个 Git common dir 相同 | 跨主机 origin 归一化 |
| nativeRead / waiting 能力 | E02、E03 候选字段；E09 官方协议 | V3/V4 行为验收 |
| freshness / async refresh | E03、E07 查询性能 | V6 持续轮询、失败隔离 |
| read、hosts 配置写入 | 产品要求与既有前端服务 | 应用存储、原子性、幂等性尚未实现 |

## 7. 文档校验

2026-10-22 已用临时安装的 openapi-spec-validator 0.7.2 和 JSON Schema 2020-12 校验器验证：

- OpenAPI 3.1.1 结构及引用有效，8 个唯一 operationId。
- 15 个组件示例、43 个响应示例、3 个请求示例通过 schema 与 date-time 格式校验。
- 6 个反例（非法状态、负耗时、错误时间、Unknown/stale 无原因、不可用轮次却带 ID）均被拒绝；6 个文档本地链接有效。
- 10 条证据 ID 唯一；示例均为合成数据。
- 校验依赖只安装在本机临时目录，不修改 frontend/package.json/lockfile，不在远端安装软件。

可在独立环境安装相同校验器后执行 `python -m openapi_spec_validator _docs/api/openapi.json` 复查结构。示例校验还需按 components/schemas 引用解析执行 JSON Schema 校验；工具默认结构校验不等于已经验证每个示例。

**未做 HTTP 集成测试**：没有真实后端。本次通过的是契约结构与示例，不是采集器功能、数据完整性或 15 秒刷新 SLA。剩余运行时验收见可行性报告 V1–V8。

